#!/usr/bin/env python3
"""Forge laptop bridge: one outbound WebSocket to the Cloudflare relay."""

from __future__ import annotations

import base64
import json
import os
import socket
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
    raise SystemExit("websocket-client is required; run the Forge installer again")

CONFIG_PATH = Path(os.environ.get("FORGE_CONFIG", str(Path.home() / ".forge" / "config.json")))
MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 25 * 1024 * 1024
CHUNK_BYTES = 16 * 1024
HOP_HEADERS = {"connection", "content-length", "content-encoding", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "set-cookie"}


def load_config():
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit("Could not read " + str(CONFIG_PATH) + ": " + str(error))
    required = ("deviceId", "deviceToken", "workerWebSocketUrl")
    if any(not config.get(key) for key in required):
        raise SystemExit("Forge config is incomplete; pair this laptop again")
    return config


def daemon_token():
    token_path = Path.home() / ".agentremoted" / "token"
    try:
        return token_path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def daemon_online(config):
    try:
        request = urllib.request.Request(str(config.get("daemonUrl", "http://127.0.0.1:8473")).rstrip("/") + "/api/ping")
        token = daemon_token()
        if token:
            request.add_header("X-Auth-Token", token)
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status < 500
    except Exception:
        return False


def validate_path(path):
    parsed = urllib.parse.urlsplit(path)
    if not parsed.path.startswith("/") or parsed.path.startswith("/internal") or ".." in parsed.path.split("/"):
        raise ValueError("Forbidden local path")
    return path


class Bridge:
    def __init__(self, config):
        self.config = config
        self.socket = None
        self.stop = threading.Event()
        self.send_lock = threading.Lock()

    def send(self, payload):
        with self.send_lock:
            if self.socket and self.socket.sock and self.socket.sock.connected:
                self.socket.send(json.dumps(payload, separators=(",", ":")))

    def on_open(self, ws):
        self.socket = ws
        self.stop.clear()
        print("Forge bridge connected", flush=True)
        self.send({"type": "heartbeat", "daemonOnline": daemon_online(self.config)})
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()

    def on_message(self, _ws, raw):
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            return
        if message.get("type") == "rpc_request" and message.get("id"):
            threading.Thread(target=self.proxy_request, args=(message,), daemon=True).start()

    def proxy_request(self, rpc):
        request_id = str(rpc["id"])
        try:
            path = validate_path(str(rpc.get("path") or "/"))
            method = str(rpc.get("method") or "GET").upper()
            if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                raise ValueError("Unsupported method")
            body_value = rpc.get("bodyBase64")
            body = base64.b64decode(body_value, validate=True) if body_value else None
            if body and len(body) > MAX_REQUEST_BYTES:
                raise ValueError("Request body is too large")
            daemon = str(self.config.get("daemonUrl", "http://127.0.0.1:8473")).rstrip("/")
            request = urllib.request.Request(daemon + path, data=body, method=method)
            request.add_header("User-Agent", "forge-bridge/3.0")
            for name, value in dict(rpc.get("headers") or {}).items():
                if str(name).lower() not in HOP_HEADERS:
                    request.add_header(str(name), str(value))
            token = daemon_token()
            if token:
                request.add_header("X-Auth-Token", token)
            try:
                response = urllib.request.urlopen(request, timeout=60)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                headers = {name: value for name, value in response.headers.items() if name.lower() not in HOP_HEADERS}
                self.send({"type": "rpc_start", "id": request_id, "status": response.status, "headers": headers})
                total = 0
                while True:
                    chunk = response.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_RESPONSE_BYTES:
                        raise ValueError("Response body is too large")
                    self.send({"type": "rpc_chunk", "id": request_id, "bodyBase64": base64.b64encode(chunk).decode("ascii")})
                self.send({"type": "rpc_end", "id": request_id})
        except Exception as error:
            self.send({"type": "rpc_error", "id": request_id, "message": str(error)[:500]})

    def heartbeat_loop(self):
        while not self.stop.wait(15):
            self.send({"type": "heartbeat", "daemonOnline": daemon_online(self.config)})

    def on_error(self, _ws, error):
        sys.stderr.write("Forge connection error: " + str(error) + "\n")

    def on_close(self, _ws, code, reason):
        self.stop.set()
        self.socket = None
        print("Forge bridge disconnected (" + str(code or "") + " " + str(reason or "") + ")", flush=True)

    def run(self):
        delay = 1
        while True:
            app = websocket.WebSocketApp(
                self.config["workerWebSocketUrl"],
                on_open=self.on_open,
                on_message=self.on_message,
                on_error=self.on_error,
                on_close=self.on_close,
            )
            app.run_forever(ping_interval=25, ping_timeout=10, sslopt={"cert_reqs": ssl.CERT_REQUIRED})
            time.sleep(delay)
            delay = min(delay * 2, 30)


def acquire_single_instance():
    lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        lock.bind(("127.0.0.1", 18473))
        lock.listen(1)
        return lock
    except OSError:
        raise SystemExit("Forge bridge is already running")


def main():
    instance_lock = acquire_single_instance()
    websocket.enableTrace(False)
    Bridge(load_config()).run()
    instance_lock.close()


if __name__ == "__main__":
    main()
