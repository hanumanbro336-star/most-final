# Original Plan (saved from user attachment)

You are modifying a WORKING, PROVEN open-source repository.
Your job is small, specific edits only. Do not rewrite anything.
Do not change architecture. Do not add new dependencies.

Base repo: https://github.com/jxw1102/agent-remote
Fork it first. All work happens on your fork.

RULE 1 — Never claim a step is done without pasting real terminal output.
RULE 2 — Work phases in order. No skipping. No combining.
RULE 3 — If something fails, stop, paste the exact error, propose one fix.
RULE 4 — Never add npm, pip packages, or new dependencies of any kind.
         The daemon is pure Python standard library. Keep it that way.

================================================================
PHASE 0 — Fork and verify baseline works UNMODIFIED
================================================================

1. Fork https://github.com/jxw1102/agent-remote to your GitHub account.
2. Clone your fork locally.
3. Run the daemon manually (not via installer yet):
   cd daemon
   PYTHONPATH=.. python3 agentremoted/main.py
4. Confirm it prints a Base URL and token.
5. curl -s http://127.0.0.1:8473/api/ping — confirm it returns JSON with a version.

CHECKPOINT 0: Paste the terminal output of the daemon starting and the ping response.
Do not proceed until confirmed with real output.

================================================================
PHASE 0.5 — NEW: prove the whole loop works BEFORE building anything
================================================================

Why this phase exists: the riskiest question is not "can I rebrand a web page,"
it's "does prompting my laptop from my phone over the internet actually work,
reliably, end to end." Answer that first, with software you didn't write.

1. Open the project's own hosted web client:
   https://nice-dune-0415af003.7.azurestaticapps.net/
2. Click "Add a daemon", enter http://127.0.0.1:8473 and the token from Phase 0.
3. Confirm the dashboard loads and shows zero sessions.
4. Start a real session with whichever of claude/codex/grok you have installed
   and logged in on this machine. Send a real prompt. Confirm a real response
   comes back.
5. Now test remote access:
   cd daemon && bash scripts/tunnel.sh
   (prints an https://xxx.trycloudflare.com URL)
6. In the hosted web client, add a second daemon entry using that HTTPS URL
   and the same token.
7. From a DIFFERENT network (phone on mobile data, not your WiFi), open the
   hosted client, connect using that URL, and send a real prompt to a real CLI
   session. Confirm a real response comes back.

CHECKPOINT 0.5: Paste confirmation that a real prompt/response round-tripped
from a different network, using the daemon + tunnel + official hosted client —
none of it your own code yet. If this doesn't work, nothing downstream will
either, and you've found that out in 10 minutes instead of after building a
branded frontend.

================================================================
PHASE 1 — Branding (web client only)
================================================================

1. Open web/agent-remote.html.
2. Change the product name from "Agent Remote" to "Zero Labs" (or your name).
3. Change any visible branding text, title tag, and favicon reference.
4. Do NOT change any JavaScript logic, API calls, or WebSocket code.
   Text and CSS only. If you are touching JS logic, stop.
5. Open the edited file in a browser locally and confirm it loads correctly
   and still connects to the daemon from Phase 0.

CHECKPOINT 1: Paste confirmation the edited web client loads and connects to
the daemon without errors. Paste the lines you changed.

================================================================
PHASE 2 — Deploy web client to Vercel (free static hosting)
================================================================

1. The web client is a single HTML file (web/agent-remote.html).
2. Create a vercel.json in the repo root:
   {
     "rewrites": [{ "source": "/(.*)", "destination": "/web/agent-remote.html" }]
   }
3. Push to GitHub. Go to vercel.com, import the repo, deploy.
   No build command needed. Output directory: web/
4. Note the Vercel URL (e.g. zero-labs.vercel.app).
5. Open that URL in a browser. Confirm the Zero Labs dashboard loads. Add a
   daemon with the test daemon URL and token from Phase 0. Confirm it connects.

CHECKPOINT 2: Paste the Vercel deployment URL and confirm the web client loads
from it and can connect to the local daemon via the token.

================================================================
PHASE 3 — Real remote access: named Cloudflare Tunnel (not the free quick tunnel)
================================================================

Why: the trycloudflare.com URL from Phase 0.5 is random and expires roughly
daily — every user would have to regenerate and re-enter a new URL constantly.
That's real friction, and the fix is free.

1. You need a Cloudflare account and a domain added to it (even a subdomain of
   one you already own works — you do not need to register a new domain).
2. Follow Cloudflare's own named tunnel docs to create a persistent tunnel and
   point a hostname (e.g. laptop.yourzerolabsdomain.com) at
   http://localhost:8473.
3. Run it as a background service (cloudflared has its own service installer,
   same idea as the daemon's launchd/systemd setup).
4. In your Vercel-hosted web client, add a daemon using that persistent
   HTTPS hostname and the token.
5. Confirm from a different network that it connects and a prompt round-trips.

CHECKPOINT 3: Paste the persistent hostname. Confirm it still connects after
closing and reopening the tunnel process (proving it survives restarts, unlike
the quick tunnel).

If you genuinely only ever intend to use this yourself (not ship it to other
users), Tailscale is a simpler alternative to a named tunnel — but it requires
installing the Tailscale app on your phone too, so it's not a fit for a
multi-user product.

================================================================
PHASE 4 — User installs daemon with one command
================================================================

1. Edit install.sh. Change the GitHub source URL to point to your fork,
   not the original repo. Do not change anything else in install.sh.
2. Test the installer on a clean machine or VM:
   curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/agent-remote/main/install.sh | bash
3. Confirm it prints a Base URL and token.

CHECKPOINT 4: Paste the installer output from a clean machine/VM.

================================================================
PHASE 5 — Light sleep configuration (keep laptop alive)
================================================================

The daemon already runs as a system service. This phase makes sure it stays
alive when the screen turns off.

ON MAC:
1. Run: sudo pmset -a sleep 0
2. Run: sudo pmset -a powernap 1
3. Verify: launchctl list | grep agentremoted
4. Test: close the lid, wait 5 minutes, send a prompt from your phone.

ON LINUX:
1. The systemd service installed by the installer keeps the daemon alive.
2. Prevent sleep: sudo systemctl mask sleep.target
3. Verify: systemctl status agentremoted
4. Test same as Mac.

HONEST CAVEAT: this works reliably when the laptop is plugged into power. On
battery with the lid fully closed, macOS may still force deep sleep eventually.
Tell users to keep the laptop plugged in for background agent mode. No product
solves laptop-off-on-battery reliably — do not promise it.

CHECKPOINT 5: Paste output of launchctl list / systemctl status showing the
daemon active, and confirmation a prompt from the phone reached the CLI with
the lid closed.

================================================================
PHASE 6 (OPTIONAL, DO LAST) — Antigravity as a provider
================================================================

Read "Antigravity reality check" below before starting this phase. If you're
optimizing for shipping something reliable soon, skip this phase for v1 and
launch with claude/codex/grok only — they already work, fully, today.

If you still want to add it:

1. Confirm the binary: run `agy --version` on a machine that has it installed.
   Paste the real output — do not guess the binary name.
2. Do NOT use headless mode (`agy -p ...`) as the integration path. It is
   known to silently return empty output when its stdout is not a real
   terminal (a subprocess call is exactly this case) — upstream bug,
   antigravity-cli#76. This will look like it "works" and do nothing, which
   is the exact failure mode you've already hit twice with this project.
3. Instead, integrate it the way the daemon integrates Claude/Grok's
   *interactive* mode: hosted inside a tmux pane, which gives agy a real
   pseudo-terminal and sidesteps the stdout bug. Study
   agentremoted/providers/claude.py or grok.py as the template for how
   interactive/tmux sessions are spawned, tracked, and torn down.
4. Session listing/resume will need custom handling: agy stores history flat
   under ~/.gemini/antigravity-cli/ (not nested per-project like Claude/Codex),
   and headless mode doesn't surface a conversation ID for the daemon to
   capture (upstream issue #7). Interactive mode sidesteps the ID problem too,
   since the daemon can attach to a live tmux session rather than resuming by ID.
5. Restart the daemon. In the web client, click New Session. Confirm
   Antigravity appears in the provider dropdown and a real session opens in
   the Live TUI view — not just that the dropdown entry exists.

CHECKPOINT 6: Paste real terminal output of an Antigravity session running
through the daemon's Live TUI, with a real prompt and a real response visible.
A working dropdown entry with no visible output is not a pass — that's the
exact bug in step 2 resurfacing.

================================================================
FINAL REPORT
================================================================

After each phase you complete, write one short paragraph:
- Phase 0: baseline working yes/no
- Phase 0.5: end-to-end proof via hosted client yes/no (this is the real test)
- Phase 1: branding changed yes/no
- Phase 2: Vercel URL working yes/no (paste URL)
- Phase 3: named tunnel persistent hostname working yes/no
- Phase 4: cross-network install test working yes/no
- Phase 5: light sleep working yes/no
- Phase 6 (if attempted): Antigravity working via tmux/interactive mode yes/no,
  with real Live TUI output pasted — not just a dropdown entry

If any phase failed, say exactly what failed and at what step. Do not round up.
"Mostly works" means it does not work.
