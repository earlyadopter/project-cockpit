# Changelog

What changed for someone using the cockpit, newest first. The dashboard shows
this file on each project's detail page. The full history is in `git log`.

## 2026-10-18 — Home screen: one work list across projects

The cockpit used to show status rather than work, and it was easy to forget how
to start it. This release makes it the first screen of the day.

### Starting it
- **Plain `cockpit` opens the dashboard.** If the dashboard is down, it restarts
  it. On first run it installs the dashboard as a login item. When piped or run
  from a script, `cockpit` with no arguments still prints the help.
- **`cockpit dash` notices a dashboard that is already running.** It prints the
  URL instead of failing on a busy port, and it says when the port belongs to
  some other program.
- **New: `cockpit doctor`.** One screen that checks:
  - the registry paths exist;
  - the login agent points at this checkout, can read files Dropbox moved to the
    cloud, and is loaded and running;
  - the dashboard answers over HTTP;
  - the Claude Code hooks are installed.

  Each problem comes with its fix. It exits 1 when something has failed.
- **Fixed: reinstalling the login agent.** `cockpit dash --install` failed every
  time it was run as a reinstall, ever since July ("Bootstrap failed: 5").
  `launchctl bootout` returns before the job has unloaded; the install now waits
  for the unload before loading the new agent.
- **Fixed: Dropbox files moved to the cloud.** The login agent can now read
  `plan.md`, the changelog and git files that Dropbox stored online-only.
  - A slow `git status` is stopped after 6 s. The card then says "git status
    timed out" instead of hanging the whole dashboard.
  - A project that can't be read shows as a degraded card, not an error page.
  - Hook events retry once after a failed read.

### Home screen (`/`)
- **Statuses, worked out live for every project:**

  | Status | Meaning |
  |---|---|
  | Needs you | an agent is waiting, or a Direction question is open |
  | Running | a Claude session is working |
  | Active | open tickets, activity in the last 7 days |
  | Cooling | open tickets, quiet for 7–30 days |
  | Unplanned | recent activity, nothing queued in `plan.md` |
  | Dormant | quiet for 30+ days |
  | Done | every ticket checked, quiet for a week |
  | Parked | you parked it in `portfolio.md` |

  "Activity" ignores `ABOUT.md`, because describing a project isn't working on it.
- **Filters.** Status chips (⌘/shift-click to combine) and a Filters menu for
  status and kind: code, or content (markdown only). The filter is kept in the
  URL, so you can bookmark a view.
- **A filtered view becomes a to-do list.** It collects what those projects
  need from you: questions to answer, commands to run by hand, your tasks,
  tickets, waiting agents, the weekly review.
  - Ticking a ticket checks it in `plan.md`.
  - Everything else ticks itself once it's resolved (pushed, committed,
    answered).
  - A progress bar tracks the day.
- **Cross-project priority in `~/.project-cockpit/portfolio.md`.**
  - Buckets: Now (at most 3), Next, Later and Parked. Drag tiles between them.
  - An **Up next** queue of `project :: ticket` lines: drag, ▲▼, check, remove,
    add. You can mark an entry `@you`.
  - Hints when the file and reality disagree: a Now project that went quiet, a
    Parked one that's busy, a queue entry whose ticket is gone, a listed project
    that isn't registered, a weekly review that's overdue.
- **Tiles.** Each tile shows:
  - the tagline from `ABOUT.md` — click to edit; a missing one is pre-drafted
    from the README;
  - last activity and the next ticket;
  - the full open-ticket list, where you can check, drag or ▲▼ to set priority,
    and add tickets;
  - **Ideate · Plan · Terminal · Open** buttons.
- **Ideate.** Keeps ideas in `plan.md` under `## Ideas`. Ideas can be typed,
  pasted, or suggested by Claude (a headless `claude -p` call; you tick the ones
  to keep). It can also open a live Claude session.
- **Plan.** Turns an idea into a feature with tickets. Type them, or have Claude
  draft them for you to edit. The idea's line is annotated `→ planned as "…"`
  rather than deleted.
- **Terminal.** Raises the project's tmux session in iTerm2, creating the
  session if needed. It never types into it.
- **Other sub-folders.** Lists folders next to your projects, plus any folder you
  add, that aren't registered yet: code, markdown-only content (notes, a book),
  or folders of folders to scan inside. Each can be added or ignored; nothing is
  added until you click.
- **For new users:**
  - an empty registry shows a welcome card that asks for the folder holding your
    projects;
  - a "Next steps" card suggests one or two features at a time;
  - `cockpit list` with no projects points at the dashboard.
- **The project page moved to `/project#<name>`** (the Open button). It now has a
  link back to the home screen.

### CLI
- **New: `cockpit demo`.** Sample projects in a sandbox on port 4401
  (`~/.project-cockpit-demo`), rebuilt on every run. It never touches your
  registry.
- **New: `cockpit roots [add|rm <path>]`.** Manage the folders whose sub-folders
  the dashboard offers as projects.

### Files and format
- **`plan.md` follows spec 1.1** (`docs/plan-md-spec.md` in ai-foundation).
  - A new optional `## Ideas` section of plain bullets.
  - The order of open tickets within a feature is their priority, and moving one
    to change priority is now an allowed single-line edit.
  - Every 1.0 file still means the same thing.
- **Edits stay surgical.** The cockpit edits `plan.md` one targeted line at a
  time. A ticket's indented notes move with it, and Windows (CRLF) line endings
  are kept.
- **The registry can hold `roots:` and `ignored:`** next to `projects:`.
- **Every new action is audit-logged** and goes through the same token and
  same-origin checks as before.

### Tests
- **New: `bun test`.** It pins every `plan.md` and `portfolio.md` write to the
  exact resulting text. The cases found in review — CRLF files, a ticket's notes,
  a negative index, `<!--` in queue text — each have a test that fails on the
  code before the fix.

## 2026-07-16/17 — Attention loop, open-sourcing, launch
- **Attention loop:**
  - waiting agents escalate amber → red after 10 minutes;
  - the agent's last message shows next to it;
  - "jump" focuses its exact tmux window;
  - opt-in Claude Code hooks give precise agent state;
  - a compact `/focus` view;
  - a quota warning before dispatching an agent;
  - per-project accent colors.
- **Open source:** MIT license, README screenshots and demo GIF, install
  one-liner, caveats section. The repo is public.
- **Fixed:** plain `cockpit go <project>`, which the `-w` flag parsing had
  broken.

## 2026-07-10 — Remote access and redesign
- **Remote access:** `--host` binds beyond localhost, with bearer-token auth on
  every request; setup over Tailscale is in `docs/remote-access.md`.
- **Redesign:** design tokens, a type scale, status dots instead of emoji, list
  rows instead of strikethrough.

## 2026-07-07/09 — Plan as command center
- **Plan card:** moved to the top of the project page, and every open ticket is
  a "work on this" button.
- **Attention chips:** each one explains the problem or fixes it (pull, create
  the config, have Claude commit). The uncommitted-files chip lists the files
  and explains submodules.
- **Parsing:** `plan.md` parsing is more tolerant of how files are written.
- **ai-foundation links:** a chip when the project's foundation install is out
  of date, and an onboarding suggestion when adding a project.

## 2026-07-06 — First release
- **CLI:** list, status, go (iTerm2 native tabs), open, run (with safety tiers),
  add, audit.
- **Dashboard:** Git, Workspace, Deploy, Commits, Changelog and Actions cards;
  actions run with safety tiers enforced by the server; a ⌘K palette.
- **Agent visibility:** shows Claude Code activity per project.
- **Plan card:** `plan.md` features, tickets and Direction questions, with
  decide, generated options and "start implementation".
- **Auto-start:** `cockpit dash --install` starts the dashboard at login
  (launchd).
