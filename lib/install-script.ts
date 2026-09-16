const DAEMON_COMMIT = 'fb8ec4e43e44099d5d86076194e98d971582fb97'

function safeUrl(value: string) {
  return value.replace(/[\r\n'"&|<>^%!]/g, '')
}

export function unixInstallScript(origin: string) {
  const safeOrigin = safeUrl(origin)
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: bash forge-install.sh ABC-DEF-GHJ" >&2
  exit 2
fi
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }

installer="\${TMPDIR:-/tmp}/forge-install-$$.py"
trap 'rm -f "$installer"' EXIT
curl -fsSL '${safeOrigin}/install.py' -o "$installer"
python3 "$installer" "$1"
`
}

export function windowsCmdInstallScript(origin: string) {
  const safeOrigin = safeUrl(origin)
  return String.raw`@echo off
setlocal
if "%~1"=="" (
  echo Usage: forge-install.cmd ABC-DEF-GHJ 1>&2
  exit /b 2
)
where py.exe >nul 2>&1 || (
  echo Python 3 is required. Install it from python.org and enable the py launcher. 1>&2
  exit /b 1
)
where curl.exe >nul 2>&1 || (
  echo curl.exe is required. 1>&2
  exit /b 1
)
set "FORGE_INSTALLER=%TEMP%\forge-install-%RANDOM%.py"
curl.exe -fsSL "${safeOrigin}/install.py" -o "%FORGE_INSTALLER%"
if errorlevel 1 (
  echo Installer download failed from ${safeOrigin}. 1>&2
  exit /b 1
)
py.exe -3 "%FORGE_INSTALLER%" "%~1"
set "FORGE_EXIT=%ERRORLEVEL%"
del /q "%FORGE_INSTALLER%" >nul 2>&1
exit /b %FORGE_EXIT%
`
}

export function pythonInstallScript(origin: string) {
  const safeOrigin = safeUrl(origin)
  return `#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ORIGIN = ${JSON.stringify(safeOrigin)}
DAEMON_REPOSITORY = "https://github.com/jxw1102/agent-remote.git"
DAEMON_COMMIT = "${DAEMON_COMMIT}"
FORGE_HOME = Path.home() / ".forge"
AGENT_HOME = FORGE_HOME / "agent-remote"
VENV_HOME = FORGE_HOME / "venv"


def fail(message):
    raise SystemExit("Forge install failed: " + message)


def run(command, **kwargs):
    try:
        subprocess.run(command, check=True, **kwargs)
    except (OSError, subprocess.CalledProcessError) as error:
        fail(str(error))


def download(path, destination):
    try:
        request = urllib.request.Request(ORIGIN + path, headers={"User-Agent": "forge-installer/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            destination.write_bytes(response.read())
    except Exception as error:
        fail("could not download " + path + ": " + str(error))


def claim(code):
    payload = json.dumps({
        "code": code,
        "name": socket.gethostname(),
        "platform": platform.system(),
    }).encode("utf-8")
    request = urllib.request.Request(
        ORIGIN + "/api/pair/claim",
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "forge-installer/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8")).get("error")
        except Exception:
            detail = None
        fail(detail or ("pairing request returned HTTP " + str(error.code)))
    except Exception as error:
        fail("could not reach the Forge app: " + str(error))


def install_daemon():
    if not shutil.which("git"):
        fail("Git is required to install the local agent daemon")
    if AGENT_HOME.exists() and not (AGENT_HOME / ".git").is_dir():
        shutil.rmtree(AGENT_HOME)
    if not AGENT_HOME.exists():
        run(["git", "clone", "--filter=blob:none", "DAEMON_REPOSITORY_PLACEHOLDER", str(AGENT_HOME)])
    run(["git", "-C", str(AGENT_HOME), "fetch", "--depth", "1", "origin", DAEMON_COMMIT])
    run(["git", "-C", str(AGENT_HOME), "checkout", "--detach", DAEMON_COMMIT])


def configure_daemon():
    daemon_home = Path.home() / ".agentremoted"
    daemon_home.mkdir(parents=True, exist_ok=True)
    config_path = daemon_home / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    except (OSError, ValueError):
        config = {}
    config.update({"bind": "127.0.0.1", "port": 8473})
    config_path.write_text(json.dumps(config, indent=2) + "\\n", encoding="utf-8")


def write_startup(python_executable):
    daemon_path = AGENT_HOME / "daemon"
    bridge_python = VENV_HOME / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if os.name == "nt":
        start_path = FORGE_HOME / "start.cmd"
        start_path.write_text(
            "@echo off\\r\\n"
            + "set \\\"PYTHONPATH=" + str(daemon_path) + "\\\"\\r\\n"
            + "start \\\"\\\" /B \\\"" + python_executable + "\\\" -m agentremoted --bind 127.0.0.1 --port 8473 >> \\\"" + str(FORGE_HOME / "daemon.log") + "\\\" 2>&1\\r\\n"
            + "timeout /t 2 /nobreak >nul\\r\\n"
            + "start \\\"\\\" /B \\\"" + str(bridge_python) + "\\\" \\\"" + str(FORGE_HOME / "bridge.py") + "\\\" >> \\\"" + str(FORGE_HOME / "bridge.log") + "\\\" 2>&1\\r\\n",
            encoding="utf-8",
        )
        startup = Path(os.environ.get("APPDATA", str(Path.home()))) / "Microsoft/Windows/Start Menu/Programs/Startup"
        startup.mkdir(parents=True, exist_ok=True)
        (startup / "Forge.cmd").write_text("@call \\\"" + str(start_path) + "\\\"\\r\\n", encoding="utf-8")
        subprocess.Popen(["cmd.exe", "/c", str(start_path)], creationflags=0x08000000)
        return

    start_path = FORGE_HOME / "start.sh"
    start_path.write_text(
        "#!/usr/bin/env bash\\n"
        + "export PYTHONPATH=" + shell_quote(str(daemon_path)) + "\\n"
        + "if ! curl -fsS http://127.0.0.1:8473/api/ping >/dev/null 2>&1; then\\n"
        + "  " + shell_quote(python_executable) + " -m agentremoted --bind 127.0.0.1 --port 8473 >> " + shell_quote(str(FORGE_HOME / "daemon.log")) + " 2>&1 &\\n"
        + "  sleep 2\\n"
        + "fi\\n"
        + "exec " + shell_quote(str(bridge_python)) + " " + shell_quote(str(FORGE_HOME / "bridge.py")) + " >> " + shell_quote(str(FORGE_HOME / "bridge.log")) + " 2>&1\\n",
        encoding="utf-8",
    )
    start_path.chmod(0o700)
    if platform.system() == "Darwin":
        launch_agents = Path.home() / "Library/LaunchAgents"
        launch_agents.mkdir(parents=True, exist_ok=True)
        plist = launch_agents / "app.forge.bridge.plist"
        plist.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>app.forge.bridge</string><key>ProgramArguments</key><array><string>""" + str(start_path) + """</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
""", encoding="utf-8")
        subprocess.run(["launchctl", "unload", str(plist)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run(["launchctl", "load", str(plist)])
    elif shutil.which("systemctl"):
        units = Path.home() / ".config/systemd/user"
        units.mkdir(parents=True, exist_ok=True)
        unit = units / "forge-bridge.service"
        unit.write_text("[Unit]\\nDescription=Forge outbound laptop bridge\\nAfter=network-online.target\\n[Service]\\nExecStart=" + str(start_path) + "\\nRestart=always\\nRestartSec=5\\n[Install]\\nWantedBy=default.target\\n", encoding="utf-8")
        run(["systemctl", "--user", "daemon-reload"])
        run(["systemctl", "--user", "enable", "--now", "forge-bridge.service"])
    else:
        subprocess.Popen([str(start_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def shell_quote(value):
    return "'" + value.replace("'", "'\\\"'\\\"'") + "'"


def main():
    if len(sys.argv) != 2:
        fail("one pairing code is required")
    code = sys.argv[1].strip().upper()
    FORGE_HOME.mkdir(parents=True, exist_ok=True)
    print("Claiming pairing code...")
    credentials = claim(code)
    print("Installing isolated Python environment...")
    if not VENV_HOME.exists():
        run([sys.executable, "-m", "venv", str(VENV_HOME)])
    venv_python = VENV_HOME / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    run([str(venv_python), "-m", "pip", "install", "--disable-pip-version-check", "--quiet", "websocket-client==1.8.0"])
    download("/bridge.py", FORGE_HOME / "bridge.py")
    print("Installing pinned local daemon...")
    install_daemon()
    configure_daemon()
    config = {
        "deviceId": credentials["deviceId"],
        "deviceToken": credentials["deviceToken"],
        "workerWebSocketUrl": credentials["workerWebSocketUrl"],
        "daemonUrl": "http://127.0.0.1:8473",
    }
    (FORGE_HOME / "config.json").write_text(json.dumps(config, indent=2) + "\\n", encoding="utf-8")
    write_startup(sys.executable)
    print("Forge is installed and will reconnect automatically.")
    print("Logs: " + str(FORGE_HOME / "bridge.log"))


if __name__ == "__main__":
    main()
`.replace('DAEMON_REPOSITORY_PLACEHOLDER', '${DAEMON_REPOSITORY}')
}

const DAEMON_REPOSITORY = 'https://github.com/jxw1102/agent-remote.git'
