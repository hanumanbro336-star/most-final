# Deep Research: Will the "fork agent-remote + rebrand + Vercel + Cloudflare tunnel" plan actually work?

Date: 2026-09-14
Original plan saved at: `docs/original-plan.md`

## Verdict up front

**The plan works as a personal tool. It does NOT work as a production product.**
The architecture (browser → Cloudflare tunnel → local daemon) is proven, but two
of its pillars — quick tunnels and per-user named tunnels — are dead ends at
multi-user scale, and the security model is not shippable to strangers.

---

## 1. What checks out (the good news)

- **The repo is real and actively maintained.** `jxw1102/agent-remote`, MIT
  license, created 2026-08, detailed changelog up to v2.9.2. The daemon is
  pure Python stdlib, installs as launchd/systemd service, token-authenticated
  API on `127.0.0.1:8473`.
- **The core loop is proven.** Daemon → tmux-hosted CLI (claude/codex/grok) →
  SSE/WebSocket live status → web client. Permission prompts, queueing, stop,
  rewind, file drop all implemented. This is the hard 80% and it's done.
- **Static web client on Vercel works.** The client is a single HTML file that
  talks directly to daemon URLs; hosting it on Vercel is trivial and the
  project itself hosts one on Azure Static Apps the same way.
- **Cloudflare tunnels do carry the traffic.** The project's own docs
  (`docs/remote-access.md`) recommend quick tunnels for demos and named
  tunnels/Tailscale for stable access. WebSockets are supported by Cloudflare
  on all plans.

## 2. Where it breaks (the fatal flaws for a product)

### Flaw 1 — Quick tunnels are explicitly not for production
Cloudflare's own docs: quick tunnels (`trycloudflare.com`) are "designed
exclusively for testing and development":
- **No SSE support** — and this daemon's live status stream is `/sse/status`
  and `/ws/status`. Live updates break over the exact tunnel the plan tells
  every user to run.
- **Hard cap of 200 concurrent in-flight requests** → 429 errors.
- **URL changes every run** — every laptop restart gives every user a new URL
  to re-enter into their phone.
- Single connection, no SLA.

### Flaw 2 — Named tunnels destroy the "one simple command" UX
The plan's fix for Flaw 1 is a named Cloudflare tunnel. But that requires
**each end user** to:
1. Create a Cloudflare account,
2. Add/transfer a domain (or subdomain) to Cloudflare DNS,
3. Run `cloudflared tunnel login` in a browser, create a tunnel, install it as
   a service, route a hostname.

That is 15+ minutes of DNS/account setup per user. Your product promise is
"visit website → run one command → done." Named tunnels contradict the entire
pitch. There is no way to automate this away for non-technical users.

### Flaw 3 — Security model is not shippable to strangers
- The daemon token is a **static bearer token** granting **full remote code
  execution** on the laptop: shell endpoints, TUI key injection, file
  read/delete (`/api/drop/<name>/delete`), file upload. Anyone who obtains
  URL + token owns the machine.
- TLS terminates at Cloudflare; the token sits in the browser's localStorage
  of a static page. One XSS or one leaked token = compromised laptop.
- No per-user identity, no revocation, no audit log, no device management.
  "Rotate if exposed" is not a production answer when the exposed credential
  is root-equivalent.
- You (the product owner) would be operating the infrastructure that carries
  RCE-capable traffic in plaintext-to-you. That is a legal/liability problem
  (abuse, CFAA-adjacent risk) even if nothing is ever breached.

### Flaw 4 — Smaller but real friction
- `curl | bash` + launchd on macOS hits Gatekeeper/notarization questions and
  enterprise MDM blocks; needs a signed/notarized path eventually.
- Sleep: `sudo pmset -a sleep 0` needs admin rights and doesn't survive lid-
  closed-on-battery (deep sleep). The plan's own caveat is honest — but a
  product needs a supported answer (`caffeinate` wrapper, power assertions via
  IOKit, clear "plugged in" guidance in the UI).
- No auto-update channel: users must re-run the curl command manually forever.
- CORS/mixed content: the static HTTPS client can only talk to HTTPS daemon
  URLs; any user who types an `http://` LAN URL gets silent browser blocking.
  The project's own troubleshooting table lists this.

## 3. Market validation (someone already built the better version)

**Happy Coder** (open source, `npm install -g happy`) does exactly this
product with the exact architecture this research recommends:
- CLI wrapper on the computer, `happy` prints a **QR code**, scan with phone →
  paired. No accounts, no tunnels, no DNS.
- Session data encrypted locally with **AES-256-GCM**; the relay server is a
  **zero-knowledge message queue** that only ever stores encrypted blobs.
- Works from any network because the daemon dials **out** to the relay.

Omnara and similar "control Claude Code from your phone" products use the same
outbound-relay pattern. VS Code Remote Tunnels, ngrok, and Tailscale all work
on the same principle: **the machine behind NAT makes the outbound connection;
no inbound path is ever needed.**

## 4. Conclusion

| Question | Answer |
|---|---|
| Does the daemon + CLI loop work? | Yes, proven. |
| Does browser-on-phone → tunnel → daemon work? | Yes, over named tunnels. |
| Do quick tunnels work for live status? | No — no SSE, 200-req cap, ephemeral URLs. |
| Can every user set up a named tunnel? | No — needs Cloudflare account + domain per user. |
| Is the token model safe for a public product? | No — static token = full RCE. |
| Is there a proven better architecture? | Yes — outbound WebSocket relay + E2E encryption + QR pairing (Happy Coder model). |

**Recommendation: keep the daemon (it's the hard part and it's MIT-licensed —
fork it), replace the connectivity and security layers.** See
`docs/better-approach.md`.
