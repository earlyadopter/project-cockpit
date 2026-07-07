# cockpit

A local project cockpit: one CLI + dashboard for working on many AI-assisted projects at once — live status, named recoverable workspaces, tiered safe actions, agent visibility, and a per-project plan. Founding brief: [planning/project-cockpit.md](planning/project-cockpit.md).

One binary, five verbs, no daemon, no cache — every call recomputes live state from `git`, `tmux`, and `lsof`.

```
cockpit list                      all projects, one status line each (attention first)
cockpit status <project>          git, tmux, services, env files, actions
cockpit go <project>              attach-or-create the project's tmux session (dev/agent/shell)
                                  In iTerm2, uses tmux control mode by default: the session's
                                  windows appear as native macOS tabs (recommended iTerm2
                                  settings: General → tmux → open windows as "Tabs in a new
                                  window", and "bury the tmux client session").
                                  --no-cc forces the classic tmux UI; --cc forces control mode.
cockpit open <project> <target>   cursor | obsidian | finder | github | deploy | dev
cockpit run <project> <action>    run a declared action — tier-enforced, audit-logged
cockpit add [path]                register a project (default: cwd)
cockpit audit                     print the audit log
cockpit dash [port]               dashboard at http://localhost:4400 (Phase 2)
```

## The mental model, in plain words

**What `<project>` means in commands:** the project's cockpit *name* — the first column of `cockpit list`. It was fixed when the project was registered: the `name:` from its `.project-cockpit.yml`, or the folder name if there is no config (so a folder `_WSET3_` can be named `wset3`). It is **not** your current directory — `cockpit go wset3` works from anywhere and always lands in wset3. A unique prefix is enough: `cockpit go modern`.

**What the three tabs are:** three empty, labeled command lines, all opened in the project folder — a desk with three labeled drawers, not three robots. Nothing runs in them by itself, and Claude cannot see or use the other tabs; it lives entirely in the tab where you started it.

- **dev** — you start the server here (`npm run dev`, or `cockpit run <p> dev` types it in for you)
- **agent** — you run `claude` (or `claude --continue` to resume a conversation) and talk to it
- **shell** — your drawer: `git push`, one-off commands

The tabs organize; they don't automate. The two exceptions where the *cockpit* does the typing: actions declared with `window:` are sent into their tmux tab, and the dashboard's "start implementation" opens a fourth `impl` tab with Claude already running. The payoff is uniformity: same three drawers in every project, and closing the window throws away nothing.

## Dashboard (Phase 2 + 3)

`cockpit dash` starts a web UI on `localhost:4400` and opens it in the browser: a project sidebar (needs-attention first) and per-project collapsible cards — Git, Workspace (tmux + ports), Deploy (date of the last push to origin's default branch — the "last PROD deploy" proxy for push-to-deploy projects), Recent commits, Changelog (auto-detected, or set `changelog:` in the repo config), and Actions. Light/dark follows the system. Refreshes every 10s; every request recomputes live state — stop and restart it freely, there is nothing to lose.

Phase 3 additions:

- **Actions run from the UI**, with the same tiers enforced *server-side*: `safe` runs on click (output shown inline, real exit code), `confirm` returns a 409 until the UI confirmation is acknowledged, `manual` is always refused (403) — the UI shows a copy button instead. Actions with `window:` are sent to the project's tmux window. Everything lands in the audit log tagged `[dash]`.
- **Open from the UI**: Cursor / Finder / Obsidian buttons (server-side `open`), web links for GitHub / deploy / local dev.
- **Command palette** (`⌘K`): switch project, open targets, run actions.
- **Audit log** view (sidebar footer).
- **＋ Add project** (sidebar): type a path (`~` works), or one-click a discovered candidate — the server scans the parent folders of registered projects for git repos not yet in the registry.
- The server binds `127.0.0.1` only and refuses cross-origin non-GET requests.

## Plan card (features · tickets · direction)

If a repo has a `plan.md` (root; or set `plan:` in the config), the dashboard renders it as the **Plan** card. Convention — plain markdown, readable everywhere:

- `## Direction` — checkbox questions about where the project should go; check when answered, keep the answer on the line
- `## Features` — one `### <feature>` block per epic, checkbox tickets under it

Rendering rules (the file is never reordered — checkboxes are the status): done tickets are struck through and sink within their feature; fully-done features are struck and sink to the bottom with a filled progress bar; open direction questions float to the top and raise an "N open questions" attention item.

**Deciding from the dashboard:** every open Direction question has an inline answer field. Submitting it (a) checks the question in `plan.md` and appends `→ <answer> (decided <date>)`, and (b) queues the work — the answer becomes a ticket under a `### Implementation queue` feature (created on first use). Two surgical line edits, audit-logged as `plan:answer`; refine the queued ticket into proper features later.

**Hints & generated options:** the `hints…` button on a question opens a popup showing any planning docs the question references (`planning/NN` is resolved against `<root>/planning/` and one level of subproject `planning/` dirs), plus a *generate options* button — a headless `claude -p` call (context inlined, no tools, ~15-60s) returns 3-5 grounded options with tradeoffs. Click to select one or more (the popup stays open; options are cached per question), then "use selected" combines them into the answer field. You still hit decide — selecting runs nothing.

**Start implementation:** after a decision is saved, the dashboard offers to start the work immediately: a new `impl` window in the project's tmux session running Claude Code, briefed with the decision and pointed at the Implementation-queue ticket. Attended, visible, interruptible — watch it with `cockpit go <project>`. Audit-logged as `plan:implement`. If you decline, nothing runs — the decision stays a queued ticket you can start any time (`cockpit go <project>`, then ask Claude in the agent tab to work the Implementation queue).

The foundation's docs rule tells Claude Code to keep the checkboxes current as it completes work, and the `plan.md` template ships with the base manifest. `cockpit status` shows a one-line summary.

## Agent visibility (Phase 4)

The cockpit detects Claude Code activity per project — best-effort, from two local traces: `claude` processes (matched to project roots by cwd) and session transcripts under `~/.claude/projects/` (mtime = last activity; the last message distinguishes a finished turn from a mid-turn stall, i.e. a likely permission prompt). States:

- **working ✳** — process present, transcript written in the last ~45s
- **waiting ✋** — process present, quiet: either "turn finished — waiting for your input" or "stalled mid-turn — possibly waiting for permission". Raises an `agent waiting for you` attention item.
- **idle** — process present, no activity for 30+ min
- **none** — no Claude Code process in that project

Shown in `cockpit list` (agent✳ / agent✋ column), `cockpit status`, the dashboard sidebar, and the Workspace card. Heuristic by design — it reads undocumented traces and is never load-bearing: the cockpit still only *observes* agents, never drives them.

## Install

Requires [bun](https://bun.sh) (runs the TypeScript directly — no build step) and tmux.

```bash
cd cockpit && bun install
ln -sf "$PWD/bin/cockpit" ~/.local/bin/cockpit
cockpit dash --install   # optional: dashboard auto-starts at login and self-restarts (launchd)
```

`--install` writes `~/Library/LaunchAgents/com.project-cockpit.dash.plist` (RunAtLoad + KeepAlive, PATH including Homebrew/bun so tmux detection works; logs at `~/.project-cockpit/dash.log`). Remove with `cockpit dash --uninstall`. After a reboot the dashboard is simply there — but tmux sessions are not: recreate each with `cockpit go <project>`, and resume a project's Claude conversation with `claude --continue` in its agent tab.

## Data

- **Registry:** `~/.project-cockpit/registry.yml` — a list of project root paths. That's all the global state.
- **Per-repo config:** `.project-cockpit.yml` at the repo root (template: `foundation/templates/common/.project-cockpit.yml`). Optional — without it, cockpit degrades to git + tmux info with the folder name as the slug.
- **Audit log:** `~/.project-cockpit/audit.log` — append-only TSV: timestamp, project, action, tier, result.

## Safety tiers (enforced, not advisory)

- `safe` — runs immediately (still audit-logged)
- `confirm` — asks `y/N` first
- `manual` — **never executed**; prints the command (with `cd`) for you to copy-paste. Exit code 2.

Actions with a `window:` key are sent to that tmux window (e.g. long-running dev servers); others run inline in the project root and return the real exit code.
