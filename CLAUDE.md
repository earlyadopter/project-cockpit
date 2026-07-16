# CLAUDE.md

<!-- BEGIN FOUNDATION:claude-instructions -->

## Project overview

Local project cockpit: a CLI (`cockpit`) + localhost dashboard for working on many AI-assisted projects at once — live git/tmux/agent status, tiered safe actions, per-project plan.md.

## Quick reference

| Action | Command |
|---|---|
| Install | `bun install` (no build step — bun runs the TS directly) |
| Run dashboard | `bun src/server.ts 4400` (or `cockpit dash`) |
| Test | none yet — verify by driving CLI + curl on the API |
| CLI | `./bin/cockpit` (symlinked to `~/.local/bin/cockpit`) |

## Key directories

| Path | Purpose |
|---|---|
| `src/state.ts` | shared state layer — registry, config, git/tmux/agent detection, plan.md, actions. CLI and server must both use it |
| `src/cockpit.ts` | the CLI (list/status/go/open/run/dash/add/audit) |
| `src/server.ts` | dashboard: Bun.serve API + single-page UI in the PAGE template literal |

## AI context files

Before starting work, read these files for project context:

- `.ai/repo-map.md` — directory structure and key entry points
- `.ai/conventions.md` — coding patterns and project rules
- `.ai/known-risks.md` — fragile areas and gotchas
- `.ai/domain-language.md` — project-specific terminology

## Rules

Read and follow the rules in `.ai/rules/`. Key rules:

- Read files before modifying them
- Run tests after making changes
- Do not modify production config without confirmation
- Keep changes minimal — only do what was asked
- Update docs when you change behavior they describe
- If a changelog exists, update it after every meaningful change (see `.ai/rules/docs.md`)

<!-- END FOUNDATION:claude-instructions -->

## Project-specific instructions

### Architecture invariants
- **Never cache live state.** Every request/command recomputes from `git`, `tmux`, `lsof`, and the filesystem. The only persistent state: `~/.project-cockpit/registry.yml` (project paths), `audit.log` (append-only), `agent-events.log` (hook-event signal buffer, size-capped), and `token` (dashboard bearer token, 0600).
- **Safety tiers are enforced server-side** (`safe` runs, `confirm` requires explicit acknowledgment, `manual` is always refused with a copy-paste command). Never let a UI change weaken this.
- **plan.md edits are surgical single-line changes** — never reorder or rewrite the file.
- The dashboard binds `127.0.0.1` by default and rejects cross-origin non-GET. Any non-loopback bind (`--host`) must keep enforcing bearer-token auth on every request (`docs/remote-access.md`); never let a change weaken that or default the bind wider.
- Runs under launchd (`cockpit dash --install`); after moving code, reinstall the agent.
- The cockpit **observes** Claude Code sessions (process cwd + transcript traces, best-effort heuristics; opt-in `cockpit hooks --install` upgrades to precise hook events — hooks report, never drive); the only agent-starting path is the explicit "start implementation" flow. Focus/jump features select tmux windows and raise iTerm2 but never type into them.
- **No sounds, ever.** Audio features are vetoed by the owner — attention signals stay visual.
