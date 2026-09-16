#!/usr/bin/env python3
"""Forge bridge: maintain one outbound WebSocket and proxy requests to agentremoted."""

from __future__ import annotations

import base64
import json
import os
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import websocket
except ImportError:
    sys.stderr.write("Missing websocket-client. Run: python -m pip install --user websocket-client\n")
    raise SystemExit(1)

CONFIG_PATH = Path(os.environ.get("FORGE_CONFIG", str(Path.home() / ".forge" / "config.json")))
DEFAULT_DAEMON_URL = "http://127.0.0.1:8473"
MAX_RESPONSE_BYTES = 2_000_000
STREAM_IDLE_SECONDS = 60
STREAM_MAX_SECONDS = 60 * 60
STREAM_MAX_BYTES = 64 * 1024 * 1024
STREAM_CHUNK_BYTES = 16 * 1024


def load_config():
    if not CONFIG_PATH.exists():
        raise SystemExit("Missing %s — run the install command from the Forge website." % CONFIG_PATH)
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit("Could not read %s: %s" % (CONFIG_PATH, error))
    missing = [key for key in ("relayUrl", "deviceId", "deviceToken") if not config.get(key)]
    if missing:
        raise SystemExit("Config missing %s — pair this laptop again." % ", ".join(missing))
    return config


def http_request(url, payload=None, headers=None, method=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method or ("GET" if data is None else "POST"))
    request.add_header("User-Agent", "forge-bridge/2.0")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        if key.lower() not in ("host", "content-length", "connection", "authorization", "cookie"):
            request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout, context=ssl.create_default_context()) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("Local daemon response exceeded 2 MB")
        return response.status, dict(response.headers.items()), body


def daemon_token(config):
    if config.get("daemonToken"):
        return config["daemonToken"]
    path = Path.home() / ".agentremoted" / "token"
    try:
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""
    except OSError:
        return ""


def daemon_url(config):
    return str(config.get("daemonUrl") or DEFAULT_DAEMON_URL).rstrip("/")


def ping_daemon(config, token):
    try:
        status, _, _ = http_request(
            daemon_url(config) + "/api/ping",
            headers={"X-Auth-Token": token} if token else None,
            timeout=3,
        )
        return status < 500
    except Exception:
        return False


def jobs_snapshot(config, token):
    try:
        status, _, body = http_request(
            daemon_url(config) + "/api/jobs",
            headers={"X-Auth-Token": token} if token else None,
            timeout=4,
        )
        if status >= 400:
            return {"active": []}
        parsed = json.loads(body.decode("utf-8") or "{}")
        if isinstance(parsed, list):
            return {"active": parsed}
        if isinstance(parsed, dict):
            return {"active": parsed.get("jobs") or parsed.get("active") or []}
    except Exception:
        pass
    return {"active": []}


def run_job(job, config, token, emit=None):
    job_id = str(job.get("id") or "")
    path = str(job.get("path") or "/")
    if not path.startswith("/") or path.startswith("/internal"):
        return {"type": "result", "id": job_id, "error": "Forbidden local path", "responseStatus": 403}
    query = str(job.get("query") or "")
    url = daemon_url(config) + path + (("?" + query) if query else "")
    method = str(job.get("method") or "GET").upper()
    if method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"):
        return {"type": "result", "id": job_id, "error": "Unsupported method", "responseStatus": 405}

    headers = {}
    for key, value in dict(job.get("headers") or {}).items():
        if str(key).lower() not in ("host", "content-length", "connection", "authorization", "cookie"):
            headers[str(key)] = str(value)
    if token:
        headers["X-Auth-Token"] = token
    body = job.get("body")
    data = None if body is None else str(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("User-Agent", "forge-bridge/2.0")
    for key, value in headers.items():
        request.add_header(key, value)

    try:
        response = urllib.request.urlopen(request, timeout=STREAM_IDLE_SECONDS)
    except urllib.error.HTTPError as error:
        response = error
    except Exception as error:
        return {"type": "result", "id": job_id, "error": str(error), "responseStatus": 502}

    with response:
        response_headers = dict(response.headers.items())
        content_type = str(response.headers.get("content-type") or "").lower()
        should_stream = emit is not None and (
            "text/event-stream" in content_type or
            str(response.headers.get("transfer-encoding") or "").lower() == "chunked")
        if should_stream:
            emit({"type": "stream_start", "id": job_id,
                  "responseStatus": response.status,
                  "responseHeaders": response_headers})
            started = time.monotonic()
            streamed_bytes = 0
            reader = getattr(response, "read1", response.read)
            while True:
                if time.monotonic() - started > STREAM_MAX_SECONDS:
                    raise RuntimeError("Local daemon stream exceeded one hour")
                chunk = reader(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                streamed_bytes += len(chunk)
                if streamed_bytes > STREAM_MAX_BYTES:
                    raise RuntimeError("Local daemon stream exceeded 64 MB")
                emit({"type": "stream_chunk", "id": job_id,
                      "encoding": "base64",
                      "data": base64.b64encode(chunk).decode("ascii")})
            emit({"type": "stream_end", "id": job_id})
            return None

        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Local daemon response exceeded 2 MB")
        try:
            response_body = raw.decode("utf-8")
        except UnicodeDecodeError:
            response_body = base64.b64encode(raw).decode("ascii")
            response_headers["X-Forge-Binary"] = "1"
        return {"type": "result", "id": job_id,
                "responseStatus": response.status,
                "responseHeaders": response_headers,
                "responseBody": response_body}


def websocket_url(config):
    base = str(config["relayUrl"]).rstrip("/")
    parsed = urllib.parse.urlparse(base)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    query = urllib.parse.urlencode({"deviceId": config["deviceId"]})
    return urllib.parse.urlunparse((scheme, parsed.netloc, "/v1/device/connect", "", query, ""))


class Bridge:
    def __init__(self, config):
        self.config = config
        self.socket = None
        self.stop_event = threading.Event()
        self.send_lock = threading.Lock()
        self.heartbeat_thread = None

    def send(self, payload):
        raw = json.dumps(payload, separators=(",", ":"))
        with self.send_lock:
            if self.socket and self.socket.sock and self.socket.sock.connected:
                self.socket.send(raw)

    def status_payload(self, message_type="heartbeat"):
        token = daemon_token(self.config)
        ok = ping_daemon(self.config, token)
        return {
            "type": message_type,
            "daemonOk": ok,
            "status": jobs_snapshot(self.config, token) if ok else {"active": []},
        }

    def on_open(self, socket):
        self.socket = socket
        self.stop_event.clear()
        print("forge-bridge connected", flush=True)
        self.send(self.status_payload("hello"))
        self.heartbeat_thread = threading.Thread(target=self.heartbeat_loop, daemon=True)
        self.heartbeat_thread.start()

    def on_message(self, _socket, raw):
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            return
        if message.get("type") != "rpc" or not message.get("id"):
            return
        threading.Thread(target=self.execute_job, args=(message,), daemon=True).start()

    def execute_job(self, job):
        token = daemon_token(self.config)
        started_stream = [False]

        def emit(payload):
            if payload.get("type") == "stream_start":
                started_stream[0] = True
            self.send(payload)

        try:
            result = run_job(job, self.config, token, emit=emit)
            if result is not None:
                self.send(result)
        except Exception as error:
            self.send({
                "type": "stream_error" if started_stream[0] else "result",
                "id": str(job.get("id") or ""),
                "error": str(error),
                "responseStatus": 502,
            })

    def heartbeat_loop(self):
        while not self.stop_event.wait(10):
            try:
                self.send(self.status_payload())
            except Exception as error:
                sys.stderr.write("heartbeat error: %s\n" % error)

    def on_error(self, _socket, error):
        sys.stderr.write("connection error: %s\n" % error)

    def on_close(self, _socket, code, reason):
        self.stop_event.set()
        self.socket = None
        print("forge-bridge disconnected (%s %s)" % (code or "", reason or ""), flush=True)

    def run_forever(self):
        delay = 1
        while True:
            app = websocket.WebSocketApp(
                websocket_url(self.config),
                header=["Authorization: Bearer " + self.config["deviceToken"]],
                on_open=self.on_open,
                on_message=self.on_message,
                on_error=self.on_error,
                on_close=self.on_close,
            )
            app.run_forever(ping_interval=25, ping_timeout=10, sslopt={"cert_reqs": ssl.CERT_REQUIRED})
            time.sleep(delay)
            delay = min(delay * 2, 30)


def main():
    websocket.enableTrace(False)
    config = load_config()
    print("forge-bridge starting for %s" % config["deviceId"], flush=True)
    Bridge(config).run_forever()


if __name__ == "__main__":
    main()
