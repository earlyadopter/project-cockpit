# cockpit — Phase 1 CLI

The weekend-build tier (Design B) of the project cockpit. Spec: [planning/cockpit-design.md](../planning/cockpit-design.md) §4 §8; tracking: [issue #10](https://github.com/earlyadopter/ai-foundation/issues/10).

One binary, five verbs, no daemon, no cache — every call recomputes live state from `git`, `tmux`, and `lsof`.

```
cockpit list                      all projects, one status line each (attention first)
cockpit status <project>          git, tmux, services, env files, actions
cockpit go <project> [--cc]       attach-or-create the project's tmux session (dev/agent/shell)
                                  --cc uses tmux control mode: iTerm2 renders the session's
                                  windows as native macOS tabs
cockpit open <project> <target>   cursor | obsidian | finder | github | deploy | dev
cockpit run <project> <action>    run a declared action — tier-enforced, audit-logged
cockpit add [path]                register a project (default: cwd)
cockpit audit                     print the audit log
```

## Install

Requires [bun](https://bun.sh) (runs the TypeScript directly — no build step) and tmux.

```bash
cd cockpit && bun install
ln -sf "$PWD/bin/cockpit" ~/.local/bin/cockpit
```

## Data

- **Registry:** `~/.project-cockpit/registry.yml` — a list of project root paths. That's all the global state.
- **Per-repo config:** `.project-cockpit.yml` at the repo root (template: `foundation/templates/common/.project-cockpit.yml`). Optional — without it, cockpit degrades to git + tmux info with the folder name as the slug.
- **Audit log:** `~/.project-cockpit/audit.log` — append-only TSV: timestamp, project, action, tier, result.

## Safety tiers (enforced, not advisory)

- `safe` — runs immediately (still audit-logged)
- `confirm` — asks `y/N` first
- `manual` — **never executed**; prints the command (with `cd`) for you to copy-paste. Exit code 2.

Actions with a `window:` key are sent to that tmux window (e.g. long-running dev servers); others run inline in the project root and return the real exit code.
