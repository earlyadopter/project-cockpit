# AI-Assisted Development

This project uses [ai-foundation](https://github.com/your-org/ai-foundation) for AI-assisted development structure.

## What's included

| File/Directory | Purpose |
|---|---|
| `CLAUDE.md` | Top-level instructions for Claude and other AI agents |
| `.ai/repo-map.md` | Directory structure and key entry points |
| `.ai/architecture.md` | System architecture overview |
| `.ai/conventions.md` | Coding patterns and project rules |
| `.ai/known-risks.md` | Fragile areas and gotchas |
| `.ai/domain-language.md` | Project-specific terminology |
| `.cursor/rules/project.mdc` | Cursor IDE rules |

## How to use

AI agents (Claude, Cursor, Copilot) automatically read `CLAUDE.md` and `.ai/` files to understand the project context. Keep these files up to date as the project evolves.

## Updating

To update foundation-managed content (sections between `<!-- BEGIN FOUNDATION:... -->` and `<!-- END FOUNDATION:... -->` markers), run:

```bash
/path/to/ai-foundation/scripts/upgrade-project.sh .
```

Content outside managed blocks is never modified by upgrades.
