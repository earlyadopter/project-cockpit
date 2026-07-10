# Remote access — dashboard on your phone/iPad, agents over SSH

The cockpit dashboard can run and audit commands on your machine, so remote
access is deliberate, not default. Out of the box it binds `127.0.0.1` and is
unreachable from anywhere else. This guide covers the supported way to reach it
from other devices — a private [Tailscale](https://tailscale.com) network plus
the built-in bearer-token auth — and the SSH + tmux path for driving full
Claude Code sessions from a phone or iPad.

**Never expose the dashboard to the raw internet** (no port-forwards, no
`--host 0.0.0.0` on a public interface, no reverse proxies without their own
auth). The token gates every request, but the transport is plain HTTP; inside a
tailnet that's fine because Tailscale encrypts everything with WireGuard —
on the open internet it is not.

## How auth works

- Binding to anything other than `127.0.0.1` / `localhost` / `::1` **enforces a
  bearer token on every request** — the server refuses to run wide-open. The
  token is generated once and persisted to `~/.project-cockpit/token`
  (mode 0600), so restarts, reboots, and launchd keep the same token.
- Three ways to present it:
  1. **One-time login URL** — open `http://<host>:4400/?token=<token>` once;
     the server sets an `HttpOnly; SameSite=Strict` cookie (30 days) and
     redirects to a clean `/`. This is the phone/iPad flow.
  2. **`Authorization: Bearer <token>`** header — for `curl` and scripts.
  3. Explicit override: `cockpit dash --token <t>` or the `COCKPIT_TOKEN`
     env var (useful for testing; the file is the durable default).
- Localhost binds stay friction-free: no token, and requests with a
  non-local `Host` header are refused (DNS-rebinding guard).
- Rotate the token by deleting `~/.project-cockpit/token` and restarting the
  dashboard; every device then needs the new login URL.

## Setup: Tailscale + `--host`

1. Install Tailscale on the Mac running the cockpit and on your phone/iPad;
   sign both into the same tailnet.
2. Find the Mac's tailnet address:

   ```bash
   tailscale ip -4        # e.g. 100.101.102.103
   # or use the MagicDNS name, e.g. my-mac.tailnet-name.ts.net
   ```

3. Start the dashboard bound to that address:

   ```bash
   cockpit dash --host 100.101.102.103
   ```

   It prints the tokened login URL. Open it once on your phone — you're in,
   and the cookie keeps you in for 30 days.

4. To make it permanent (starts at login, survives reboots):

   ```bash
   cockpit dash --install --host 100.101.102.103
   ```

   The token never goes into the launchd plist — the server reads it from
   `~/.project-cockpit/token`. The login URL is printed to
   `~/.project-cockpit/dash.log`.

Note: binding to the Tailscale IP means the dashboard is *only* reachable over
the tailnet — even localhost stops working (use the tailnet address from the
Mac too, or run a second localhost instance on another port). Tailscale IPs are
stable, but if you prefer names, MagicDNS names work anywhere the IP does.

## API access from scripts

```bash
TOKEN=$(cat ~/.project-cockpit/token)
curl -H "Authorization: Bearer $TOKEN" http://100.101.102.103:4400/api/projects
```

Safety tiers are enforced server-side regardless of transport: `safe` runs,
`confirm` needs the explicit confirmation flag, `manual` is always refused with
a copy-paste command. Everything is audit-logged.

## Driving agent sessions: SSH + tmux

The dashboard shows status and runs declared actions, but steering a live
Claude Code session is a terminal job. Over the same tailnet:

1. Enable **Remote Login** on the Mac (System Settings → General → Sharing),
   or use `tailscale ssh` if you run Tailscale SSH.
2. From the phone/iPad, use an SSH client with good keyboard support —
   [Blink Shell](https://blink.sh) or Termius on iOS work well.
3. Attach to a project's workspace:

   ```bash
   ssh <mac-tailnet-name>
   cockpit go my-project --no-cc     # classic tmux UI; -CC is iTerm2-only
   ```

   You land in the project's tmux session (`dev` / `agent` / `shell` windows,
   plus any `impl`/`commit` windows the dashboard spawned). Resume a closed
   conversation with `claude --continue` in the agent window.

Typical phone loop: glance at the dashboard → an agent shows **waiting on
you** → SSH in, `cockpit go <project>`, answer the prompt, detach.

## Caveats

- The dashboard is single-user by design: one token, no accounts, no roles.
- Plain HTTP — safe **only** inside a WireGuard-encrypted tailnet or on
  localhost. Don't put it behind a public hostname.
- macOS-only bits (`open`, launchd, iTerm2 `-CC`) apply to the host Mac;
  the phone only needs a browser and an SSH client.
