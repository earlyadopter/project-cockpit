# Global Rules

These rules apply to all AI agent interactions in this project.

## Read before you write

- Always read a file before modifying it
- Understand existing code and conventions before suggesting changes
- Check for related files that might be affected by your change

## Be explicit about file paths

- Use full relative paths when referencing files (e.g. `src/utils/auth.ts`, not "the auth file")
- When creating or moving files, state the exact target path
- Never assume a file location — verify it exists first

## Respect what exists

- Do not refactor, rename, or reorganize code unless explicitly asked
- Preserve existing patterns and conventions even if you'd do it differently
- Do not add comments, docstrings, or type annotations to code you didn't change
- Do not remove code that looks unused without confirming with the user

## Production safety

- Never modify production config, environment variables, or deployment files without explicit confirmation
- Do not change database schemas, migrations, or seed data casually
- Flag any change that could affect running services
- Prefer reversible changes over irreversible ones

## Keep changes minimal

- Only make changes that are directly requested or clearly necessary
- Don't add error handling, validation, or fallbacks for scenarios that can't happen
- Three similar lines of code is better than a premature abstraction
- A bug fix doesn't need surrounding code cleaned up

## Ask when uncertain

- If a request is ambiguous, ask for clarification rather than guessing
- If you're about to make a destructive or hard-to-reverse change, confirm first
- If you don't know how something works in this project, say so
