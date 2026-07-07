# Skill: Onboard Existing Project

## Purpose

Inspect an existing repository and add the AI-assisted development structure (`.ai/` directory, `CLAUDE.md`, conventions) without disrupting what already exists.

## When to use

Use this skill when you are working in a repo that:
- Has existing code and history
- Does not yet have `.ai/` or `CLAUDE.md`
- Needs AI structure added safely

## Instructions

Follow these steps in order. Do not skip steps.

### Step 1: Inspect the repo

Scan the repository to understand its current state. Collect:

- **Stack**: Languages, frameworks, and major libraries (check `package.json`, `requirements.txt`, `pyproject.toml`, `Gemfile`, `go.mod`, `Cargo.toml`, or similar)
- **Test setup**: Test framework, test directory location, how to run tests (check `Makefile`, `package.json` scripts, CI config)
- **Build/run commands**: How to build, start, and develop locally
- **Existing docs**: List all documentation files (`README.md`, `docs/`, `CHANGELOG.md`, `CONTRIBUTING.md`, `planning/`, etc.)
- **Existing AI config**: Check for `.ai/`, `CLAUDE.md`, `.cursor/`, `.github/copilot/`, or similar
- **CI/CD**: Check for `.github/workflows/`, `Jenkinsfile`, `.circleci/`, `.gitlab-ci.yml`
- **Key directories**: Identify `src/`, `lib/`, `app/`, `tests/`, `scripts/`, and other important paths

### Step 2: Determine what's missing

Compare what you found against the baseline set of files:

| File | Purpose |
|---|---|
| `.ai/repo-map.md` | Directory structure and key entry points |
| `.ai/conventions.md` | Coding patterns and project-specific rules |
| `.ai/known-risks.md` | Fragile areas, gotchas, things to be careful about |
| `CLAUDE.md` | Top-level AI agent instructions |

If any of these already exist, **do not overwrite them**.

### Step 3: Create missing files

For each missing file, create it with content based on what you learned in Step 1.

**`.ai/repo-map.md`** — Fill in the actual directory structure, key files, entry points, and test locations you discovered.

**`.ai/conventions.md`** — Document the actual patterns you observed: naming conventions, file organization, import style, error handling approach, etc.

**`.ai/known-risks.md`** — Note any fragile areas you identified: complex modules, files with many dependencies, areas with no test coverage, environment-specific behavior, etc.

**`CLAUDE.md`** — Create project-specific instructions including:
- What this project does (one sentence)
- How to build and run it
- How to run tests
- Key directories and their purpose
- Link to `.ai/` files for deeper context

### Step 4: Generate the onboarding report

Create `.ai/onboarding-report.md` with the following sections:

```markdown
# Onboarding Report

Generated: [date]

## Detected stack
- [language]
- [framework]
- [test framework]

## Build and run commands
- Build: [command]
- Run: [command]
- Test: [command]

## Existing docs found
- [list of doc files found]

## Existing AI config found
- [list, or "None"]

## Files added
- [list of files you created]

## Files skipped (already exist)
- [list of files that already existed]

## Recommended follow-ups
- [specific suggestions for this project]
```

### Step 5: Summarize

Tell the user:
1. What you found
2. What you added
3. What you recommend doing next

## Rules

- **Never overwrite existing files** unless the user explicitly asks you to
- **Never delete anything** — this is an additive operation only
- **Be specific** — fill templates with actual project information, not placeholders
- **Be honest** — if you can't determine something (e.g. how to run tests), say so in the report rather than guessing
- When in doubt, add a recommendation to the follow-ups section rather than making an assumption
