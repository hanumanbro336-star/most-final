function safeShellUrl(value: string) {
  return value.replace(/['\r\n]/g, '')
}

export function installScript(origin: string, relayUrl: string) {
  const safeOrigin = safeShellUrl(origin)
  const safeRelay = safeShellUrl(relayUrl)
  return `#!/usr/bin/env bash
set -euo pipefail

ORIGIN='${safeOrigin}'
RELAY='${safeRelay}'
FORGE_HOME="\${HOME}/.forge"
mkdir -p "\$FORGE_HOME"

command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required."; exit 1; }

echo "→ installing secure WebSocket support"
if ! python3 -m venv "\$FORGE_HOME/venv"; then
  echo "Python venv support is required (on Debian/Ubuntu: install python3-venv)."
  exit 1
fi
"\$FORGE_HOME/venv/bin/python" -m pip install --disable-pip-version-check -q websocket-client

echo "→ requesting a one-time pairing code"
python3 - "\$RELAY" "\$FORGE_HOME" <<'PY'
import json, platform, socket, sys, time, urllib.error, urllib.request, webbrowser
from pathlib import Path
relay, home = sys.argv[1], Path(sys.argv[2])
def post(path, payload):
    req = urllib.request.Request(relay + path, data=json.dumps(payload).encode(), headers={"Content-Type":"application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read().decode())
pair = post("/v1/pair/start", {"name": socket.gethostname(), "platform": platform.system()})
print("\nPairing code: " + pair["userCode"])
print("Approve at: " + pair["verificationUriComplete"] + "\n")
try: webbrowser.open(pair["verificationUriComplete"])
except Exception: pass
deadline = time.time() + int(pair.get("expiresIn", 600))
while time.time() < deadline:
    time.sleep(max(2, int(pair.get("interval", 3))))
    try:
        result = post("/v1/pair/poll", {"deviceCode": pair["deviceCode"]})
        if result.get("status") == "approved":
            config = {"relayUrl": relay, "deviceId": result["deviceId"], "deviceToken": result["deviceToken"], "daemonUrl": "http://127.0.0.1:8473"}
            home.mkdir(parents=True, exist_ok=True)
            (home / "config.json").write_text(json.dumps(config, indent=2) + "\n")
            print("Pairing approved.")
            break
    except urllib.error.HTTPError as error:
        if error.code == 410: raise SystemExit("Pairing code expired. Run the installer again.")
else:
    raise SystemExit("Pairing timed out. Run the installer again.")
PY

curl -fsSL "\$ORIGIN/bridge.py" -o "\$FORGE_HOME/bridge.py"
chmod 700 "\$FORGE_HOME/bridge.py"

if command -v git >/dev/null 2>&1; then
  if [[ ! -d "\$FORGE_HOME/agent-remote/daemon" ]]; then
    echo "→ installing the loopback-only agent daemon"
    git clone --depth 1 https://github.com/jxw1102/agent-remote.git "\$FORGE_HOME/agent-remote"
  fi
  DAEMON_DIR="\$FORGE_HOME/agent-remote/daemon/agentremoted"
  PROVIDER_DIR="\$DAEMON_DIR/providers"
  curl -fsSL "\$ORIGIN/api/agent-remote/config.py" -o "\$DAEMON_DIR/config.py"
  curl -fsSL "\$ORIGIN/api/agent-remote/__init__.py" -o "\$PROVIDER_DIR/__init__.py"
  curl -fsSL "\$ORIGIN/api/agent-remote/cursor.py" -o "\$PROVIDER_DIR/cursor.py"
  curl -fsSL "\$ORIGIN/api/agent-remote/antigravity.py" -o "\$PROVIDER_DIR/antigravity.py"
  curl -fsSL "\$ORIGIN/api/agent-remote/antigravity_interactive.py" -o "\$PROVIDER_DIR/antigravity_interactive.py"

  if ! command -v claude >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || echo "Warning: Claude Code was not installed." >&2; fi
  if ! command -v codex >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then npm install -g @openai/codex >/dev/null 2>&1 || echo "Warning: Codex was not installed." >&2; fi
  if ! command -v cursor-agent >/dev/null 2>&1; then curl -fsSL https://cursor.com/install | bash >/dev/null 2>&1 || echo "Warning: install Cursor Agent later from cursor.com." >&2; fi
  if ! command -v agy >/dev/null 2>&1; then
    if command -v gcloud >/dev/null 2>&1; then gcloud components install antigravity --quiet >/dev/null 2>&1 || echo "Warning: install the Antigravity agy CLI later." >&2
    else echo "Warning: Antigravity requires the agy CLI and Google Cloud SDK." >&2; fi
  fi

  mkdir -p "\$HOME/.agentremoted"
  python3 - "\$HOME/.agentremoted/config.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
try: data = json.loads(path.read_text()) if path.exists() else {}
except (OSError, ValueError): data = {}
data.update({"bind": "127.0.0.1", "port": 8473,
             "providers": ["claude", "codex", "cursor", "antigravity"]})
for key in ("claude", "codex", "cursor", "antigravity"):
    data.setdefault(key + "_default_cwd", str(pathlib.Path.home()))
path.write_text(json.dumps(data, indent=2) + "\\n")
PY
else
  echo "git is not installed; install it later to add the local agent daemon."
fi

if [[ -f "\$HOME/.agentremoted/token" ]]; then
  python3 - "\$FORGE_HOME/config.json" "\$HOME/.agentremoted/token" <<'PY'
import json, sys
from pathlib import Path
config_path, token_path = map(Path, sys.argv[1:])
config = json.loads(config_path.read_text())
config["daemonToken"] = token_path.read_text().strip()
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY
fi

cat > "\$FORGE_HOME/start.sh" <<'SH'
#!/usr/bin/env bash
FORGE_HOME="$HOME/.forge"
if [[ -d "$FORGE_HOME/agent-remote/daemon" ]] && ! curl -sf http://127.0.0.1:8473/api/ping >/dev/null 2>&1; then
  PYTHONPATH="$FORGE_HOME/agent-remote/daemon" python3 -m agentremoted --bind 127.0.0.1 --port 8473 >> "$FORGE_HOME/daemon.log" 2>&1 &
fi
exec "$FORGE_HOME/venv/bin/python" "$FORGE_HOME/bridge.py" >> "$FORGE_HOME/bridge.log" 2>&1
SH
chmod 700 "\$FORGE_HOME/start.sh"

if [[ "\$(uname -s)" == "Darwin" ]]; then
  PLIST="\$HOME/Library/LaunchAgents/app.forge.bridge.plist"
  mkdir -p "\$(dirname "\$PLIST")"
  cat > "\$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>app.forge.bridge</string><key>ProgramArguments</key><array><string>\$FORGE_HOME/start.sh</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>\$FORGE_HOME/service.log</string><key>StandardErrorPath</key><string>\$FORGE_HOME/service.log</string></dict></plist>
PLIST
  launchctl unload "\$PLIST" >/dev/null 2>&1 || true
  launchctl load "\$PLIST"
elif command -v systemctl >/dev/null 2>&1; then
  mkdir -p "\$HOME/.config/systemd/user"
  cat > "\$HOME/.config/systemd/user/forge-bridge.service" <<UNIT
[Unit]
Description=Forge outbound laptop bridge
After=network-online.target
[Service]
ExecStart=\$FORGE_HOME/start.sh
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now forge-bridge.service
else
  nohup "\$FORGE_HOME/start.sh" >/dev/null 2>&1 &
fi

echo
echo "Forge is installed and will reconnect automatically."
echo "Logs: \$FORGE_HOME/bridge.log"
`
}

export function windowsCmdInstallScript(origin: string) {
  const safeOrigin = origin.replace(/[\r\n"&|<>^%!]/g, '')
  return String.raw`@echo off
setlocal
set "FORGE_ORIGIN=${safeOrigin}"
set "FORGE_INSTALLER=%TEMP%\forge-install-%RANDOM%.ps1"

where curl.exe >nul 2>&1 || (
  echo curl.exe is required. Install a current version of Windows, then try again.
  exit /b 1
)
where powershell.exe >nul 2>&1 || (
  echo Windows PowerShell is required by the installer.
  exit /b 1
)

curl.exe -fsSL "%FORGE_ORIGIN%/install.ps1" -o "%FORGE_INSTALLER%"
if errorlevel 1 (
  echo Installer download failed. Make sure %FORGE_ORIGIN% is public.
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%FORGE_INSTALLER%" %*
set "FORGE_EXIT=%ERRORLEVEL%"
del /q "%FORGE_INSTALLER%" >nul 2>&1
exit /b %FORGE_EXIT%
`
}

export function windowsInstallScript(origin: string, relayUrl: string) {
  const safeOrigin = origin.replace(/['\r\n]/g, '')
  const safeRelay = relayUrl.replace(/['\r\n]/g, '')
  return String.raw`$ErrorActionPreference = 'Stop'
$Origin = '${safeOrigin}'
$Relay = '${safeRelay}'
$ForgeHome = Join-Path $HOME '.forge'
New-Item -ItemType Directory -Force -Path $ForgeHome | Out-Null

if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw 'Python 3 is required.' }
Write-Host 'Installing secure WebSocket support...'
$Venv = Join-Path $ForgeHome 'venv'
py -m venv $Venv
$ForgePython = Join-Path $Venv 'Scripts\python.exe'
& $ForgePython -m pip install --disable-pip-version-check -q websocket-client

$PairBody = @{ name = $env:COMPUTERNAME; platform = 'Windows' } | ConvertTo-Json
$Pair = Invoke-RestMethod -Method Post -Uri "$Relay/v1/pair/start" -ContentType 'application/json' -Body $PairBody
Write-Host ''
Write-Host "Pairing code: $($Pair.userCode)"
Write-Host "Approve at: $($Pair.verificationUriComplete)"
Write-Host ''
Start-Process $Pair.verificationUriComplete
$Deadline = (Get-Date).AddSeconds($Pair.expiresIn)
do {
  Start-Sleep -Seconds ([Math]::Max(2, $Pair.interval))
  $Poll = Invoke-RestMethod -Method Post -Uri "$Relay/v1/pair/poll" -ContentType 'application/json' -Body (@{ deviceCode = $Pair.deviceCode } | ConvertTo-Json)
} while ($Poll.status -ne 'approved' -and (Get-Date) -lt $Deadline)
if ($Poll.status -ne 'approved') { throw 'Pairing timed out. Run the installer again.' }

$Config = @{ relayUrl = $Relay; deviceId = $Poll.deviceId; deviceToken = $Poll.deviceToken; daemonUrl = 'http://127.0.0.1:8473' }
$Config | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $ForgeHome 'config.json')
Invoke-WebRequest -UseBasicParsing "$Origin/bridge.py" -OutFile (Join-Path $ForgeHome 'bridge.py')

if (Get-Command git -ErrorAction SilentlyContinue) {
  $AgentHome = Join-Path $ForgeHome 'agent-remote'
  if (-not (Test-Path (Join-Path $AgentHome 'daemon'))) { git clone --depth 1 https://github.com/jxw1102/agent-remote.git $AgentHome }
  $DaemonPackage = Join-Path $AgentHome 'daemon\agentremoted'
  $ProviderHome = Join-Path $DaemonPackage 'providers'
  Invoke-WebRequest -UseBasicParsing "$Origin/api/agent-remote/config.py" -OutFile (Join-Path $DaemonPackage 'config.py')
  Invoke-WebRequest -UseBasicParsing "$Origin/api/agent-remote/__init__.py" -OutFile (Join-Path $ProviderHome '__init__.py')
  Invoke-WebRequest -UseBasicParsing "$Origin/api/agent-remote/cursor.py" -OutFile (Join-Path $ProviderHome 'cursor.py')
  Invoke-WebRequest -UseBasicParsing "$Origin/api/agent-remote/antigravity.py" -OutFile (Join-Path $ProviderHome 'antigravity.py')
  Invoke-WebRequest -UseBasicParsing "$Origin/api/agent-remote/antigravity_interactive.py" -OutFile (Join-Path $ProviderHome 'antigravity_interactive.py')
  if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) { npm install -g @anthropic-ai/claude-code }
  if (-not (Get-Command codex -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) { npm install -g @openai/codex }

  $DaemonHome = Join-Path $HOME '.agentremoted'
  New-Item -ItemType Directory -Force -Path $DaemonHome | Out-Null
  $DaemonConfig = Join-Path $DaemonHome 'config.json'
  $DaemonSettings = if (Test-Path $DaemonConfig) { Get-Content -Raw $DaemonConfig | ConvertFrom-Json } else { [PSCustomObject]@{} }
  $DaemonSettings | Add-Member -Force NoteProperty bind '127.0.0.1'
  $DaemonSettings | Add-Member -Force NoteProperty port 8473
  $DaemonSettings | Add-Member -Force NoteProperty providers @('claude','codex','cursor','antigravity')
  $DaemonSettings | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $DaemonConfig
  $TokenPath = Join-Path $DaemonHome 'token'
  if (Test-Path $TokenPath) {
    $Config.daemonToken = (Get-Content -Raw $TokenPath).Trim()
    $Config | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $ForgeHome 'config.json')
  }
}

$StartScript = @'
$ForgeHome = Join-Path $HOME '.forge'
$AgentHome = Join-Path $ForgeHome 'agent-remote\daemon'
if (Test-Path $AgentHome) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8473/api/ping | Out-Null } catch {
    $env:PYTHONPATH = $AgentHome
    Start-Process -WindowStyle Hidden py -ArgumentList '-m','agentremoted','--bind','127.0.0.1','--port','8473'
  }
}
$ForgePython = Join-Path $ForgeHome 'venv\Scripts\python.exe'
Start-Process -WindowStyle Hidden $ForgePython -ArgumentList (Join-Path $ForgeHome 'bridge.py')
'@
$StartPath = Join-Path $ForgeHome 'start.ps1'
$StartScript | Set-Content -Encoding UTF8 $StartPath
$Startup = [Environment]::GetFolderPath('Startup')
('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $StartPath + '"') | Set-Content -Encoding ASCII (Join-Path $Startup 'Forge.cmd')
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $StartPath
Write-Host ''
Write-Host 'Forge is installed and will reconnect automatically.'
`
}
