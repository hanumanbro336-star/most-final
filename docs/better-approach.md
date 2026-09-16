# Better Approach: Production-Ready "Visit site → run one command → control your laptop"

Companion to `docs/research-findings.md`. This is the architecture to build.

**Superseded for implementation by:**

- `docs/production-research.md` — why Vercel cannot hold the laptop pipe, Durable Objects, pairing
- `docs/forge-architecture.md` — locked Forge architecture (sidecar, not a daemon fork)
- `docs/forge-build-prompt.md` — phase-gated execution prompt (paste this to build)

## The one-sentence change

**Stop making users open a hole into their laptop (tunnel). Make the laptop
dial out to you (relay).** The daemon keeps an outbound WebSocket open to your
server; your website talks to your server; your server routes between them.
No ports, no tunnels, no Cloudflare accounts, no domains, no static tokens.

```
BEFORE (original plan)                      AFTER (recommended)

Phone browser ──HTTPS──▶ Vercel page        Phone browser ──HTTPS──▶ Your Next.js app
      │                                            │
      ▼                                            ▼
trycloudflare / named tunnel          YOUR RELAY (WebSocket router)
      │                                            ▲
      ▼                                            │ outbound WSS (daemon dials YOU)
Daemon on laptop  ◀── static token                 └──────────────────────────
(full RCE if token leaks)                  Daemon on laptop (no inbound ports)
```

## Why this wins on every axis

| Requirement | Tunnel plan | Outbound relay |
|---|---|---|
| User setup | curl install + Cloudflare account + domain + tunnel service | curl install + paste 6-digit code (or scan QR) |
| URL stability | breaks (quick) or per-user DNS (named) | permanent — it's your domain |
| Live SSE/WS status | broken on quick tunnels | first-class, you own the pipe |
| NAT / CGNAT / hotel Wi-Fi | hit-or-miss | always works (outbound only) |
| Credential theft blast radius | full RCE forever until rotated | E2E encrypted; relay can't read traffic; keys revocable per device |
| Your liability | you carry plaintext RCE traffic | zero-knowledge: you store only ciphertext |
| Offline events | none | relay queues encrypted messages until laptop reconnects |

## Architecture

### 1. Pairing (no signup — matches your "builds, not signs" flow)
1. User visits your site → clicks "Add my laptop" → server mints a short-lived
   **pairing code** (e.g. 6 digits, 10-min TTL) shown as text + QR.
2. User runs the one-liner. The installer prompts (or takes the code as an
   arg): `curl -fsSL https://yoursite/install.sh | bash -s -- 482913`
3. Daemon generates an **Ed25519/X25519 keypair**, sends the public key +
   pairing code to the relay over TLS. Relay marks the pairing "claimed",
   binds device → browser session. Browser derives the shared secret from the
   code (PAKE-style or code-as-PSK); from then on everything is **E2E
   encrypted** — the relay routes ciphertext it cannot read.
4. Browser stores the device key locally (IndexedDB). Reconnecting later =
   same key, no re-pairing. Optional: email magic-link later only for users
   who want multi-device sync — never required for v1.

### 2. Relay server (the only new backend you build)
- **One job:** authenticated message routing between browser sessions and
  daemon sockets. Stateless HTTP + WebSocket.
- Daemon side: daemon connects OUT to `wss://relay.yoursite.dev/device`,
  authenticates with its device key, keeps the socket open with
  heartbeat + exponential-backoff reconnect.
- Browser side: browser connects to `wss://relay.yoursite.dev/client/<device>`
  with its key.
- Routing: relay looks up device → socket, forwards frames. If daemon is
  offline, relay stores encrypted frames in a queue (Redis/Postgres) and
  flushes on reconnect — this gives you "send the prompt from the subway,
  laptop picks it up when it wakes."
- Scale: one Node/Bun process handles thousands of idle sockets; go
  multi-instance later with a Redis pub/sub fan-out. This is a small,
  boring, cheap service — a single Vercel-compatible server or a tiny
  always-on container.

### 3. The daemon (fork agent-remote — don't rewrite it)
The existing daemon is the hard 80%: tmux-hosted claude/codex/grok sessions,
permission bridging, queueing, rewind, file drop, live TUI streaming. Keep it.
Changes needed:
- Add a **relay transport** alongside the HTTP server: a stdlib-only
  WebSocket-ish client (or a tiny bundled `websockets`-style module) that
  bridges relay frames ↔ the existing internal API. The existing REST/SSE
  surface stays for localhost use.
- Replace the static token with the **device keypair**; sign every frame.
- Add **auto-update**: daemon checks your relay's `/version` endpoint daily
  and self-updates (re-run installer logic) — otherwise you're running
  support for 50 stale versions.
- Keep the guest-sandbox work (v2.8.x seatbelt jail) — it's a genuine
  differentiator for safety.

### 4. Frontend (your website = the product)
- Next.js on Vercel. Landing page → "Add laptop" → pairing screen →
  dashboard (session list, live transcript, permission prompts, Live TUI).
- The existing single-file web client proves the UI model; rebuild it as
  proper React components talking to the relay instead of direct-to-daemon.
- Everything over the E2E channel: prompts, transcripts, permission
  allow/deny, key injection, file drop.

### 5. Sleep & reliability (the honest part)
- macOS: installer registers a launchd agent; wrap long-running sessions in
  `caffeinate -i` (per-process power assertion) instead of `pmset -a sleep 0`
  — no sudo, survives display-off, doesn't fight the user's power settings.
- Show **connection status as a first-class UI element**: "🟢 Laptop online /
  🟡 asleep — will receive on wake / 🔴 offline." Set expectations instead of
  pretending. On battery + closed lid, macOS deep-sleeps; no software fixes
  that. Say "keep it plugged in" in onboarding, like every laptop-farm product
  does.
- Linux: systemd already solves it; add `Wake-on-LAN` docs as a bonus.

### 6. Security checklist (minimum for shipping to strangers)
- [ ] E2E encryption (X25519 + AES-256-GCM), relay is zero-knowledge
- [ ] Pairing codes: single-use, 10-min TTL, rate-limited
- [ ] Per-device keys → revocation UI ("log out that laptop")
- [ ] Daemon: bind localhost only, sandboxed guest mode on by default
- [ ] Relay: no plaintext logging, abuse reporting endpoint, ToS forbidding
      illegal use
- [ ] Signed/notarized macOS path eventually (ad-hoc signing + Gatekeeper
      right-click bypass for v1; document it)
- [ ] Audit log on the device (local file) of every remote command

## Build order (each step independently testable)

1. **Relay MVP** — echo router: daemon dials out, browser connects, frames
   route. Test with `wscat`. (This is the Phase 0.5 equivalent: prove the
   pipe before building anything.)
2. **Pairing flow** — code minting, claim, key exchange. End-to-end from a
   real second network.
3. **Fork the daemon, add relay transport** — one provider (claude) first;
   prompt in, transcript out, over the relay.
4. **Next.js dashboard** — sessions list, live stream, permission prompts.
5. **Installer one-liner** with embedded pairing code + launchd/systemd.
6. **Hardening** — reconnect logic, offline queue, auto-update, status UI.
7. **Then** add codex/grok providers, file drop, share links, etc.

## What to explicitly NOT do

- Don't ship quick tunnels to users (no SSE, 429s, rotating URLs).
- Don't require Cloudflare accounts/domains per user (kills the UX).
- Don't ship the static-token model to strangers (RCE liability).
- Don't build accounts/OAuth for v1 — pairing codes ARE the auth.
- Don't promise "works with lid closed on battery" — it doesn't, on any OS.
