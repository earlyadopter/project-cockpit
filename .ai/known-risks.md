# Known Risks

<!-- BEGIN FOUNDATION:known-risks -->

This file documents fragile areas, gotchas, and things to be careful about when working in this codebase. AI agents should check this file before making changes in sensitive areas.

## Fragile areas

| Area | Risk | Mitigation |
|---|---|---|
| [file or module] | [what can go wrong] | [how to avoid it] |

## Environment-specific behavior

| Behavior | Dev | Staging | Prod |
|---|---|---|---|
| [behavior] | [how it works] | [how it works] | [how it works] |

## Common gotchas

- [Gotcha 1: description and how to avoid it]
- [Gotcha 2: description and how to avoid it]

## Files with high change risk

These files have many dependents or complex logic. Extra care needed when modifying:

| File | Why it's risky | What to check |
|---|---|---|
| [file] | [reason] | [verification steps] |

<!-- END FOUNDATION:known-risks -->

## Project-specific risks

[Add risks specific to this project below. This section is preserved on upgrade.]

### Dropbox "online-only" (dataless) files under project roots

Applies to any project root under a cloud-synced folder (`~/Library/CloudStorage/...`).
The owner's projects moved to `~/Documents/projects` in 2026-10, but a user's may not have:
Dropbox evicts untouched files to cloud-only ("dataless" in `ls -lO`). Two failure modes, both seen 2026-08-23:

- **launchd can't materialize them.** launchd jobs default to *not* materializing dataless
  files, so `readFileSync` on an evicted `plan.md`/`CHANGELOG.md`/`.git/HEAD` fails with
  `EDEADLK` (Darwin errno 11) — but the same read works from a shell. The plist written by
  `cockpit dash --install` sets `MaterializeDatalessFiles=true`; after changing the plist
  template, reinstall (`cockpit dash --uninstall && cockpit dash --install`).
- **Evicted `.git/objects` make `git status` take minutes** (~1.2 s per loose object pulled
  back from Dropbox). `shA()` kills any subprocess after `SH_TIMEOUT_MS` (6 s, under Bun's
  10 s request idle timeout) and the card shows "git status timed out" instead of stalling
  the whole `/api/projects` response. Fix the repo itself by re-materializing `.git`
  (`find <repo>/.git -type f -flags +dataless -exec cat {} + > /dev/null`) and/or marking
  the folder "Available offline" in Dropbox; `git gc` (packing loose objects) shrinks the
  surface for next time.
