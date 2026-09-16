# Production research (2026-09-14)

Follow-up to `docs/research-findings.md`. Question: can Forge serve **many users**,
**no signup**, **one command**, **no per-user tunnels**, as a real product?

## Verdict

Yes — if and only if the laptop **dials out** to a relay you operate, and that
relay is **not** a Vercel function. The original tunnel plan cannot do this.
Happy Coder (23k stars, MIT) already ships this exact product shape. Forge
should copy the connectivity model, not the UX (Happy wraps `claude`; we attach
to sessions the user already has).

## 1. What "many users, no complexity" actually requires

End user must never:

- create a Cloudflare / Tailscale / ngrok account
- own a domain or touch DNS
- copy a rotating URL
- paste a long static token
- sign up / OAuth
- open inbound ports

End user must only:

1. Open the website on their phone
2. Run one command on the laptop (command includes the pairing code)
3. Use the site. Forever, same URL.

That constraint **forbids** quick tunnels, named tunnels, Tailscale, and
"paste base URL + token into the client."

## 2. Why the relay cannot live on Vercel

Vercel Fluid Compute WebSockets (2026):

- Hobby: connection dies at **300 seconds**
- Pro: dies at **800 seconds** (30 min only in a limited beta)
- Instances do not share memory; no fan-out; recycle kills the socket
- Client must reconnect when the function hits max duration

A laptop daemon must stay connected for hours/days while the lid is open and
the machine is plugged in. A 5–13 minute ceiling means constant drops, missed
permission prompts, and a support nightmare. **Do not put the daemon socket
on Vercel.**

Vercel is the right place for the **website** (landing, pairing UI, dashboard).
It is the wrong place for the **pipe**.

## 3. The production pipe: Cloudflare Durable Objects

One Durable Object per laptop. Browser and daemon both connect to it with
WebSockets. Hibernation keeps idle sockets in memory-less state:

- Idle DO does **not** accrue duration charges
- Up to 32,768 hibernating connections per object (we need 2–5: daemon + phones)
- Incoming WS messages bill at 20:1 vs HTTP requests
- SQLite-backed DO stores the encrypted offline queue
- Deploy updates restart DOs (daemons must reconnect — they already must)

This is the same primitive PartyKit now wraps. Use Durable Objects directly;
PartyKit-the-hosted-platform is no longer the thing to bet on.

**Who needs a Cloudflare account? Only you (the product owner), once.**
Users never see Cloudflare.

Plan B if you refuse Cloudflare: a single always-on Fly.io / Railway Node
process + Redis pub/sub. Works to a few thousand sockets, then you reinvent
Durable Objects. Do not start there.

## 4. Pairing without accounts (the auth model)

Signup is complexity. Pairing **is** auth.

Do **not** use 6-digit codes. 1,000,000 possibilities is brute-forceable
against a network service. Use **8-character Crockford base32** displayed as
`XXXX-XXXX` (~1.1e12 possibilities) plus:

- 10-minute TTL
- single-use
- 5 claim attempts / IP / 10 minutes
- room id = `sha256(code)` so the code itself is not stored in plaintext

Flow:

1. Phone opens Forge, taps Connect laptop.
2. Browser generates an X25519 keypair, asks the Worker to mint a pairing
   room, shows the code and the one-liner.
3. Laptop runs `curl -fsSL https://forge.dev/install | bash -s -- 7K2M-9QP4`.
4. Installer installs the localhost daemon + the outbound bridge, which
   connects to `wss://relay.forge.dev`, claims the room, does ECDH with the
   browser's public key.
5. Shared secret never leaves the two devices. Relay only routes ciphertext.
6. Browser stores the device record in IndexedDB. Next visit: already in.
7. Lost browser: on the laptop run `forge pair` to mint a new code.

This matches Happy Coder's threat model (TweetNaCl / NaCl secretbox, relay
stores opaque blobs) with a website-first UX instead of QR-from-CLI.

## 5. Do not fork the daemon. Sidecar it.

`jxw1102/agent-remote` is MIT, Python **stdlib only**, and already does the
hard 80%: tmux-hosted claude/codex/grok/dsh, permission prompts, queue, stop,
rewind, Live TUI, file drop, launchd/systemd, guest seatbelt jail.

Python has **no stdlib WebSocket client**. Adding one inside the daemon
violates its stdlib-only contract and makes upstream merges painful.

**Sidecar (`forge-bridge`):**

```
phone ──WSS/E2E──▶ Durable Object ──WSS/E2E──▶ forge-bridge ──HTTP+WS localhost──▶ agentremoted :8473
```

- Daemon binds `127.0.0.1` only. Never exposed.
- Bridge holds the device key, outbound WSS, reconnect/backoff, translates
  relay frames ↔ daemon REST/SSE.
- Daemon stays vanilla; we can pull upstream. One extra dependency
  (`websockets`) lives only in the bridge venv.
- Installer starts both as one launchd/systemd unit (bridge depends on daemon).

Happy Coder took the other path: wrap `claude` so sessions must start through
them. That is worse for our pitch. Agent Remote already lists sessions the
user started in a normal terminal. **Keep that.** It is the product difference.

## 6. Sleep, Gatekeeper, auto-update (honest production answers)

| Problem | Ship this, not a fantasy |
|---|---|
| Lid closed on battery | macOS deep-sleeps. UI shows "asleep — will receive on wake." Onboarding: keep it plugged in. `caffeinate -i` on the daemon process while plugged in / lid open. Never `sudo pmset`. |
| Gatekeeper | v1: unsigned Python scripts, document right-click Open. v2: signed/notarized. |
| Auto-update | Bridge checks `/version` daily, re-runs installer in place. Without this you support 50 versions. |
| Offline prompts | DO SQLite queue of encrypted frames, flush on daemon reconnect. |
| curl \| bash fear | Host the script on your domain (not raw GitHub), HTTPS, checksum printed on the pairing page, `--dry-run` flag. |

## 7. Liability and abuse (you are routing RCE)

The daemon can shell, inject TUI keys, delete drop files. Even with E2E:

- You still operate the matching service that lets a phone talk to a laptop.
- ToS: lawful use only, no unauthorized access to machines you do not own.
- Abuse mailbox + ability to disable a device_id on the relay (drops the
  socket; cannot read traffic).
- Guest sandbox **on by default** (agent-remote 2.8.x seatbelt jail).
- Local audit log `~/.forge/audit.log` of every remote command.
- No plaintext logs on the relay. Ever.

E2E does not make you immune to CFAA-adjacent risk. It does mean a relay
breach does not dump anyone's prompts or code.

## 8. Competitive map

| Product | Connect model | Auth | Session model |
|---|---|---|---|
| Agent Remote (upstream) | User-run tunnel | Static token | Attaches to existing CLIs |
| Happy Coder | Outbound relay, E2E | QR pair | Must start via `happy claude` |
| Omnara | Outbound WS daemon | Account | Daemon + optional cloud sandbox |
| VS Code Tunnels | Outbound to Microsoft | GitHub/MSA | Editor, not CLI agents |
| **Forge (this plan)** | Outbound DO relay, E2E | Website pairing code, no signup | Attaches to existing CLIs |

Forge's wedge: Happy's connectivity + Agent Remote's "your normal `claude`
session, remotely" + website-first zero-signup.

## 9. What we will not do

- Quick tunnels or named tunnels for users
- Static daemon tokens as the product auth
- Signup / OAuth in v1
- WebSockets for the daemon on Vercel
- Rewriting agent-remote
- Promising lid-closed-on-battery
- 6-digit pairing codes
