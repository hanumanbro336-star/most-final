# Forge architecture

Product: user opens the website (no signup), runs one command on the laptop,
controls that laptop's Claude/Codex/Grok sessions from the phone. Forever.

```
  Phone browser                    You operate                     User's laptop
 ┌──────────────┐              ┌─────────────────┐              ┌──────────────────┐
 │ Next.js app  │  HTTPS/WSS   │ CF Worker       │  outbound    │ forge-bridge     │
 │ Vercel       │─────────────▶│ + Durable Object│◀────WSS──────│ (device key, E2E)│
 │ pairing UI   │  ciphertext  │ per laptop      │  ciphertext  │        │         │
 │ dashboard    │              │ pairing rooms   │              │        ▼         │
 │ IndexedDB    │              │ offline queue   │              │ agentremoted     │
 └──────────────┘              └─────────────────┘              │ 127.0.0.1:8473   │
                                                                │ tmux + claude…   │
                                                                └──────────────────┘
```

## Components

### A. Website (this Next.js app, Vercel)

- `/` landing: one sentence, one button "Connect a laptop"
- `/pair` shows `XXXX-XXXX` + the exact command + 10-min countdown
- `/app` dashboard after pairing (sessions, transcript, permissions, Live TUI)
- No accounts. Device list lives in IndexedDB, encrypted with the pairing secret.
- Never talks to the laptop directly. Only to `wss://relay.forge.dev`.

### B. Relay (Cloudflare Worker + Durable Objects) — separate small deploy

You (the operator) deploy this once. Users never touch it.

| Object | Key | Job |
|---|---|---|
| `PairingRoom` | `sha256(code)` | 10-min TTL, two sockets (browser, bridge), ECDH handshake, then destroy |
| `DeviceRoom` | `device_id` | Long-lived. Daemon socket + N browser sockets. Route encrypted frames. SQLite queue if daemon offline. |

Worker routes:

- `POST /v1/pair/create` → `{ code, expiresAt }` (rate-limited)
- `GET /v1/pair/:code/wait` / `WSS /v1/pair/:code` → handshake
- `WSS /v1/device/:id?role=daemon|browser` → persistent room
- `GET /v1/version` → bridge auto-update
- `POST /v1/abuse` → disable device_id

No Postgres required for v1. Pairing and queue live in DO storage.
Add Neon later only if you want operator analytics or a recovery email.

### C. Laptop: unmodified daemon + forge-bridge

Installer (`https://forge.dev/install`):

1. Requires `python3`, `curl`. Detects `claude` / `codex` / `grok` / `dsh` on PATH.
2. Installs upstream `agent-remote` daemon to `~/.local/share/agent-remote` with
   `bind: 127.0.0.1`. Prints nothing about tokens to the user.
3. Creates a venv, installs `forge-bridge` (Python, dependency: `websockets`).
4. Generates Ed25519 + X25519 device keys in `~/.forge/` (mode 0600).
5. Claims the pairing code, completes ECDH, writes `~/.forge/device.json`.
6. Installs launchd (macOS) or systemd --user (Linux) for daemon + bridge.
7. Exits 0. Phone dashboard lights up.

Bridge protocol (all payloads after handshake are nonce + AES-256-GCM):

```
{ "v": 1, "type": "req"|"res"|"event"|"ping",
  "id": "uuid", "method": "GET"|"POST",
  "path": "/api/sessions", "body": ..., "seq": n }
```

Events: daemon SSE `/sse/status` and TUI snapshots become `event` frames.
Browser never learns the localhost token; the bridge injects `X-Auth-Token`.

### D. Crypto

- Handshake: X25519 ECDH, transcript includes device_id and pairing room id.
- Traffic: AES-256-GCM, 96-bit nonce, key rotation every 2^20 frames or 24h.
- Device identity: Ed25519, challenge-response on every daemon reconnect
  (stops a stranger from stealing `device_id` and sitting on the room).
- Browser identity: same, keys in IndexedDB (non-extractable CryptoKey if possible).
- Relay sees: device_id, frame size, timestamps. Never plaintext, never keys.

### E. Status model (set expectations)

```
online     — daemon socket alive in last 15s
asleep     — last seen < 12h, likely lid/sleep; queued frames will flush
offline    — last seen > 12h or never
```

Permission prompts while asleep: queued, push-notification later (v2). v1:
banner on the phone "Laptop asleep — prompt sends when it wakes."

## Scale envelope

| Users | Idle sockets | Where it lives | Cost shape |
|---|---|---|---|
| 1–50 (you + friends) | 50 | One Worker + DOs, free tier likely | ~$0 |
| 1k | 1k hibernating | Same | cents–few dollars |
| 10k | 10k hibernating | Same, watch pairing rate limits | still cheap if idle |
| Active Live TUI | wakes the DO at 2–5 Hz | billable messages | this is the real cost |

Do not poll from idle daemons. Heartbeat every 30s is enough; hibernation
survives that if you are careful. Prefer daemon-driven events over client polls.

## What the v0 app owns vs what is a Worker

Built in this Next.js repo:

- Landing, pairing screen, dashboard UI
- Browser crypto + IndexedDB
- Talk to the Worker URL via env `NEXT_PUBLIC_FORGE_RELAY_URL`

Built as `relay/` in the same repo, deployed to Cloudflare (not Vercel):

- Worker + Durable Objects
- Pairing + device rooms

Built as `bridge/` in the same repo, shipped by `public/install.sh`:

- forge-bridge
- installer that also vendors agent-remote

## v1 / v2 cut

v1 (ship): one laptop, one browser, claude+codex+grok via upstream daemon,
pairing, E2E, reconnect, offline queue, status pill, guest sandbox on.

v2: multi-laptop, `forge pair` recovery, push notifications, notarized macOS,
Antigravity, share links, Windows.
