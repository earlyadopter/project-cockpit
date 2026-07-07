# Documentation Rules

## Keep docs in sync

- When you change behavior, update the docs that describe it
- If you add a new feature, add or update the relevant documentation
- If you remove something, remove or update its documentation
- Don't leave stale docs — they're worse than no docs

## Changelog rule

If this project has a changelog file (`CHANGELOG.md`, `docs/changelog.md`, or similar):

- Add an entry after every meaningful change
- Use the date in YYYY-MM-DD format
- Write a short, clear description of what changed and why
- Group entries under date headings, newest first

## Write for the reader

- Keep docs concise and scannable — use headings, bullet points, and tables
- Write for someone who has never seen this project before
- Lead with the most important information
- Include examples when explaining non-obvious behavior

## What goes where

- Code behavior → code comments (only when logic isn't self-evident)
- API contracts → API docs or schema files
- Architecture and design → `.ai/architecture.md` or `docs/`
- How to run/deploy/test → `README.md`
- Do not duplicate information across multiple locations

## Keep plan.md current

If the repo has a `plan.md` (Direction / Features / checkbox tickets):

- When you complete work covered by a ticket, check its box (`- [x]`) in the same change
- When new work is agreed in conversation, add it as a ticket under the right feature (or a new `###` feature)
- When a direction question gets answered, check it and append the decision to the line
- Never reorder or delete entries to indicate status — checkboxes are the status
