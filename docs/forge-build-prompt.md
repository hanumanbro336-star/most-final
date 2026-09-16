# Forge — execution prompt (paste this to build)

You are building **Forge**: a production product where a user opens the
website (no signup), runs one command on their laptop, and then controls
that laptop's existing Claude / Codex / Grok sessions from their phone.

Read these first and obey them:

- `docs/production-research.md` — why this architecture, what is forbidden
- `docs/forge-architecture.md` — components, crypto, status model
- `docs/research-findings.md` — why the tunnel plan is dead
- `docs/original-plan.md` — historical; do **not** implement it

You are NOT rebranding agent-remote's hosted client.
You are NOT putting a Cloudflare tunnel on the user's machine.
You are NOT putting the daemon WebSocket on Vercel.

RULE 1 — Never claim a step is done without pasting real evidence
          (terminal output, JSON, or a screenshot description).
RULE 2 — Work phases in order. No skipping. No combining.
RULE 3 — If something fails, stop, paste the exact error, propose one fix.
RULE 4 — Daemon stays vanilla upstream (stdlib, localhost). All new
          connectivity lives in `bridge/` and `relay/`.
RULE 5 — No user accounts, OAuth, or passwords in v1. Pairing is auth.
RULE 6 — Pairing codes are 8-char Crockford (`XXXX-XXXX`), never 6 digits.
RULE 7 — Relay never logs plaintext. Guest sandbox on by default.

Product owner (you) will have one Cloudflare account for the Worker.
End users have zero accounts.

================================================================
PHASE 0 — Prove the pipe with software you barely wrote
================================================================

Goal: a phone on LTE talks to a laptop behind NAT, with no tunnel.

1. On the laptop, run upstream daemon unmodified:

   git clone --depth 1 https://github.com/jxw1102/agent-remote.git /tmp/agent-remote
   cd /tmp/agent-remote/daemon
   PYTHONPATH=. python3 -m agentremoted

   Confirm it prints Base URL `http://127.0.0.1:8473` and a token.
   `curl -s http://127.0.0.1:8473/api/ping` returns JSON with a version.

2. Write a throwaway local relay (one file, `scripts/dev-relay.mjs`) using
   the `ws` package. Behaviour:

   - `ws://127.0.0.1:8787/pair/:code` — first two sockets are paired, frames
     forwarded both ways, room dies after 10 minutes or when both leave
   - `ws://127.0.0.1:8787/device/:id` — same, persistent, no crypto yet

3. Write a throwaway bridge (`scripts/dev-bridge.py`) that:

   - Connects outbound to the local relay as role=daemon
   - Proxies each `{method,path,body}` frame to `http://127.0.0.1:8473`
     with `X-Auth-Token` from `~/.agentremoted/token`
   - Forwards `/sse/status` as event frames

4. From a second machine (phone LTE or a cloud VM), open a websocket to
   the relay (use `wscat` or a 20-line HTML page). Send
   `{ "method":"GET","path":"/api/ping" }`. Confirm the ping JSON returns.

   To reach the laptop from LTE you need the **relay** reachable, not the
   laptop. For this phase only, run the relay on a tiny public host
   (cloud VM, or `cloudflared tunnel --url http://localhost:8787` on the
   **relay process**, which is YOUR machine, not the user's product path).

CHECKPOINT 0: Paste (a) daemon ping JSON, (b) relay log showing two
sockets, (c) ping JSON received on the second network. If this fails,
stop. Nothing downstream matters.

================================================================
PHASE 1 — Pairing handshake (still no product UI)
================================================================

1. Implement code minting: 8 Crockford chars, room id = sha256(code).
2. Browser (even a 40-line HTML file) generates X25519 keypair, opens
   `wss://relay/pair/:code`.
3. Bridge claims the same room, generates X25519, ECDH, both sides derive
   a 256-bit key, send a `hello` frame encrypted, confirm decrypt.
4. Persist: bridge writes `~/.forge/device.json`; browser prints
   "paired device_id=…".
5. Subsequent traffic uses `wss://relay/device/:id` + AES-256-GCM.
6. Confirm a GET /api/sessions round-trip is ciphertext on the wire
   (log the frame hex on the relay; it must not contain "sessions").

CHECKPOINT 1: Paste proof that the relay log is opaque and that
/api/sessions still returns real JSON on the browser side after decrypt.

================================================================
PHASE 2 — Cloudflare Durable Objects (production relay)
================================================================

Replace the throwaway relay.

1. `relay/` Cloudflare Worker:
   - PairingRoom DO (TTL 10 min, single-use code)
   - DeviceRoom DO (hibernating WebSockets, SQLite offline queue)
   - Rate limit pair-create: 5 / IP / 10 min
   - Ed25519 challenge on daemon reconnect
2. Deploy to your Cloudflare account. Note `wss://relay.forge.dev`
   (or workers.dev hostname for now).
3. Point `scripts/dev-bridge.py` at it. Repeat Phase 0 test from LTE.
4. Kill the daemon 60s, send a prompt from the browser, start daemon:
   confirm the queued encrypted frame flushes.

CHECKPOINT 2: Paste the workers.dev / custom hostname, LTE round-trip,
and proof the offline queue flushed. Hibernation: after 60s idle, DO
CPU duration should stop climbing (check CF dashboard).

Do not proceed to a pretty website until this is green. A beautiful
dashboard on a dead pipe is how the original plan failed.

================================================================
PHASE 3 — forge-bridge (real, not throwaway)
================================================================

`bridge/forge_bridge/` Python package.

- Dependency: `websockets` only (venv).
- Reconnect with exp backoff + jitter, never more than 30s.
- Heartbeat 30s.
- Translate relay frames ↔ daemon HTTP + SSE + `/ws/status`.
- Inject daemon token; never send it to the relay.
- Guest sandbox left to daemon config (`true` by default).
- `~/.forge/audit.log` one line per remote command (timestamp, path, id).
- `--pair CODE` and `forge-bridge pair` to mint a recovery pairing
  (asks relay to create a room, prints code).

CHECKPOINT 3: Install into a venv, pair, send a real Claude (or Codex)
prompt from the second network, paste the real model response. Audit log
has the continue/new-session line.

================================================================
PHASE 4 — Installer (the one command)
================================================================

`public/install.sh` served at `https://<this-app>/install`.

```
curl -fsSL https://<prod-host>/install | bash -s -- 7K2M-9QP4
```

Must:

- Refuse Windows with a clear message (v1 = macOS + Linux).
- Need python3, curl, tar. Clone or tarball upstream agent-remote
  at a **pinned tag**, not floating main.
- Bind daemon to 127.0.0.1 only.
- Install bridge venv + keys + launchd/systemd --user.
- Claim the code, print nothing about tokens.
- On success: "This laptop is connected. Go back to your phone."
- `--dry-run` prints what it would do.
- Idempotent: running again updates code, keeps keys.

Test on a clean VM or a throwaway user account, not your already-working
dev machine.

CHECKPOINT 4: Paste full installer output from a clean machine and
confirm the phone (already on /pair) flipped to connected without any
other step.

================================================================
PHASE 5 — Website (this Next.js app)
================================================================

Only now.

1. Landing: one claim, one CTA. No signup, no pricing table required.
2. `/pair`: code, countdown, copyable command, QR of the same command,
   connection state (waiting → paired → redirect /app).
3. `/app`: device status pill (online / asleep / offline), session list,
   new session, transcript, permission allow/deny, Live TUI if cap set.
   All bytes via E2E channel. IndexedDB holds device records.
4. Lost-browser empty state: "On the laptop run: forge-bridge pair"
   and a code entry box.
5. Env: `NEXT_PUBLIC_FORGE_RELAY_URL`. No AI provider keys. Users' CLIs
   already hold those.

CHECKPOINT 5: From a phone on LTE, complete landing → pair → installer
on a clean laptop → send a real prompt → see a real reply. Paste the
production URL. No extra instructions beyond the one command.

================================================================
PHASE 6 — Production hardening
================================================================

- Status pill is truthful (asleep vs offline).
- `caffeinate -i` around the service on macOS; never `pmset`.
- Onboarding copy: keep laptop plugged in; lid-closed-on-battery will
  not receive until wake.
- Auto-update: bridge hits `/v1/version` daily, re-runs installer in
  place if newer.
- ToS + abuse endpoint. Ability to disable a device_id.
- Security headers on Next.js (`X-Content-Type-Options`, Referrer-Policy,
  HSTS, CSP report-only).
- Rate limits on pair-create and pair-claim.
- Do not log bodies on Worker or Next.js.

CHECKPOINT 6: Checklist ticked with evidence. Load test: 100 idle
fake bridges hibernating, 5 active TUI streams. Paste CF metrics.

================================================================
DO NOT DO
================================================================

- Quick tunnels or named tunnels as the user path
- Static daemon tokens in the browser
- Signup, magic links, OAuth in v1
- Daemon WebSockets on Vercel
- 6-digit pairing codes
- Rewriting agent-remote providers
- Antigravity in v1
- Promising lid-closed-on-battery
- Adding Neon/Better Auth until a v2 recovery-email is an explicit ask

================================================================
DONE means
================================================================

A stranger can open the site on their phone, run one command on a Mac
or Linux laptop that already has `claude` (or codex/grok) logged in,
and drive a real session from LTE, with ciphertext-only on the relay,
without creating an account. That is the product. Everything else waits.
