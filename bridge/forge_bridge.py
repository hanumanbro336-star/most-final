#!/usr/bin/env python3
"""Forge bridge — laptop dials out to the website, then proxies to local agentremoted."""

from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("FORGE_CONFIG", str(Path.home() / ".forge" / "config.json")))
DAEMON_URL = "http://127.0.0.1:8473"


def load_config():
    if not CONFIG_PATH.exists():
        sys.stderr.write("Missing %s — run the install command from the website.\n" % CONFIG_PATH)
        sys.exit(1)
    return json.loads(CONFIG_PATH.read_text())


def request(url, payload=None, headers=None, method=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method or ("GET" if data is None else "POST"))
    req.add_header("User-Agent", "forge-bridge/1.0")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        if key.lower() in ("host", "content-length", "connection"):
            continue
        req.add_header(key, value)
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        body = resp.read()
        return resp.status, dict(resp.headers.items()), body


def daemon_token(cfg):
    token = cfg.get("daemonToken")
    if token:
        return token
    path = Path.home() / ".agentremoted" / "token"
    if path.exists():
        return path.read_text().strip()
    return ""


def ping_daemon(token):
    try:
        status, _, body = request(
            DAEMON_URL + "/api/ping",
            headers={"X-Auth-Token": token} if token else None,
            timeout=2,
        )
        return status < 500, body
    except Exception:
        return False, b""


def run_job(job, token):
    path = job.get("path") or "/"
    query = job.get("query") or ""
    url = DAEMON_URL + path + (("?" + query) if query else "")
    method = (job.get("method") or "GET").upper()
    headers = dict(job.get("headers") or {})
    if token:
        headers["X-Auth-Token"] = token
    body = job.get("body")
    data = None if body is None else (body.encode("utf-8") if isinstance(body, str) else body)
    try:
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("User-Agent", "forge-bridge/1.0")
        for key, value in headers.items():
            if key.lower() in ("host", "content-length", "connection"):
                continue
            req.add_header(key, value)
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read()
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                import base64

                text = base64.b64encode(raw).decode("ascii")
                hdrs = dict(resp.headers.items())
                hdrs["X-Forge-Binary"] = "1"
                return {
                    "id": job["id"],
                    "responseStatus": resp.status,
                    "responseHeaders": hdrs,
                    "responseBody": text,
                }
            return {
                "id": job["id"],
                "responseStatus": resp.status,
                "responseHeaders": dict(resp.headers.items()),
                "responseBody": text,
            }
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            text = raw.decode("utf-8")
        except Exception:
            text = ""
        return {
            "id": job["id"],
            "responseStatus": err.code,
            "responseHeaders": dict(err.headers.items()) if err.headers else {},
            "responseBody": text,
        }
    except Exception as err:
        return {"id": job["id"], "error": str(err), "responseStatus": 502}


def jobs_snapshot(token):
    try:
        status, _, body = request(
            DAEMON_URL + "/api/jobs",
            headers={"X-Auth-Token": token} if token else None,
            timeout=3,
        )
        if status >= 400:
            return {"active": []}
        parsed = json.loads(body.decode("utf-8") or "{}")
        if isinstance(parsed, list):
            return {"active": parsed}
        if isinstance(parsed, dict):
            return {"active": parsed.get("jobs") or parsed.get("active") or []}
        return {"active": []}
    except Exception:
        return {"active": []}


def loop(cfg):
    origin = cfg["origin"].rstrip("/")
    device_id = cfg["deviceId"]
    secret = cfg["laptopSecret"]
    url = origin + "/api/devices/" + device_id + "/sync"
    results = []
    print("forge-bridge online → %s" % origin, flush=True)
    print("waiting for the phone page to flip to connected (step 4)", flush=True)
    while True:
        token = daemon_token(cfg)
        daemon_ok, _ = ping_daemon(token)
        payload = {
            "daemonOk": daemon_ok,
            "status": jobs_snapshot(token) if daemon_ok else {"active": []},
            "results": results,
        }
        try:
            _, _, body = request(
                url,
                payload=payload,
                headers={"Authorization": "Bearer " + secret},
                timeout=30,
            )
            data = json.loads(body.decode("utf-8") or "{}")
            results = []
            jobs = data.get("jobs") or []
            if jobs:
                print("rpc x%s" % len(jobs), flush=True)
            for job in jobs:
                results.append(run_job(job, token))
            if not jobs:
                time.sleep(0.2)
        except Exception as err:
            sys.stderr.write("sync error: %s\n" % err)
            results = []
            time.sleep(2)


def main():
    cfg = load_config()
    required = ("origin", "deviceId", "laptopSecret")
    missing = [key for key in required if not cfg.get(key)]
    if missing:
        sys.stderr.write("config missing %s\n" % ", ".join(missing))
        sys.exit(1)
    loop(cfg)


if __name__ == "__main__":
    main()
