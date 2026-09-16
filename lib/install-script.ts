export function installScript(origin: string) {
  const safeOrigin = origin.replace(/'/g, '')
  return `#!/usr/bin/env bash
set -euo pipefail

ORIGIN='${safeOrigin}'
CODE="\${1:-}"
FORGE_HOME="\${HOME}/.forge"

if [[ -z "\$CODE" ]]; then
  echo "Usage: curl -fsSL \$ORIGIN/install | bash -s -- XXXX-XXXX"
  echo "Copy the command from the website — the pairing code is already in it."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required. Install Python 3 and run this again."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required."
  exit 1
fi

mkdir -p "\$FORGE_HOME"
echo "→ pairing \$CODE with \$ORIGIN"

CLAIM=\$(curl -sS -X POST "\$ORIGIN/api/pair/claim" \\
  -H 'content-type: application/json' \\
  -d "{\\"code\\":\\"\$CODE\\",\\"hostname\\":\\"\$(hostname)\\",\\"platform\\":\\"\$(uname -s)\\"}")

python3 - "\$CLAIM" "\$ORIGIN" "\$FORGE_HOME" <<'PY'
import json, sys
from pathlib import Path
raw, origin, home = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.loads(raw)
if "error" in data:
    raise SystemExit(data["error"])
cfg = {
    "origin": origin,
    "deviceId": data["deviceId"],
    "laptopSecret": data["laptopSecret"],
    "daemonUrl": data.get("daemonUrl") or "http://127.0.0.1:8473",
}
Path(home).mkdir(parents=True, exist_ok=True)
Path(home, "config.json").write_text(json.dumps(cfg, indent=2) + "\\n")
print("paired as", data["deviceId"])
PY

curl -fsSL "\$ORIGIN/bridge.py" -o "\$FORGE_HOME/bridge.py"
chmod +x "\$FORGE_HOME/bridge.py"

# Bind the imported agent-remote daemon to loopback only.
if command -v git >/dev/null 2>&1; then
  if [[ ! -d "\$FORGE_HOME/agent-remote/daemon" ]]; then
    echo "→ installing agent-remote daemon (loopback only)"
    git clone --depth 1 https://github.com/jxw1102/agent-remote.git "\$FORGE_HOME/agent-remote"
  fi
  mkdir -p "\$HOME/.agentremoted"
  if [[ ! -f "\$HOME/.agentremoted/config.json" ]]; then
    cat > "\$HOME/.agentremoted/config.json" <<'JSON'
{
  "bind": "127.0.0.1",
  "port": 8473,
  "providers": ["claude", "grok", "codex"]
}
JSON
  fi
  if ! curl -sf "http://127.0.0.1:8473/api/ping" >/dev/null 2>&1; then
    echo "→ starting agentremoted on 127.0.0.1:8473"
    nohup env PYTHONPATH="\$FORGE_HOME/agent-remote/daemon" AGENTREMOTED_HOME="\$HOME/.agentremoted" python3 -m agentremoted --bind 127.0.0.1 --port 8473 \\
      >> "\$FORGE_HOME/daemon.log" 2>&1 &
    echo \$! > "\$FORGE_HOME/daemon.pid"
    sleep 2
  fi
else
  echo "git not found — bridge will still connect; install git to add the daemon."
fi

if [[ -f "\$HOME/.agentremoted/token" ]]; then
  python3 - "\$FORGE_HOME/config.json" "\$HOME/.agentremoted/token" <<'PY'
import json, sys
from pathlib import Path
cfg_path, token_path = Path(sys.argv[1]), Path(sys.argv[2])
cfg = json.loads(cfg_path.read_text())
cfg["daemonToken"] = token_path.read_text().strip()
cfg_path.write_text(json.dumps(cfg, indent=2) + "\\n")
PY
fi

if [[ -f "\$FORGE_HOME/bridge.pid" ]] && kill -0 "\$(cat "\$FORGE_HOME/bridge.pid")" 2>/dev/null; then
  kill "\$(cat "\$FORGE_HOME/bridge.pid")" 2>/dev/null || true
fi

echo "→ starting forge-bridge (laptop dials out; no ports opened)"
nohup python3 "\$FORGE_HOME/bridge.py" >> "\$FORGE_HOME/bridge.log" 2>&1 &
echo \$! > "\$FORGE_HOME/bridge.pid"
sleep 1

echo
echo "Laptop is dialing out."
echo "Look at the website — step 4 should flip to connected."
echo
echo "Logs:  tail -f \$FORGE_HOME/bridge.log"
echo "Stop:  kill \$(cat \$FORGE_HOME/bridge.pid)"
echo
`
}
