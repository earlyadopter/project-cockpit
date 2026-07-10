# Plan

## Direction

- [x] Extract from ai-foundation to own repo? → yes, done with full git history via subtree split (decided 2026-07-07)
- [x] Open-source it? (license, name check, publish where — see checklist below) → yes, open-source it (without breaking my cockpit) (decided 2026-07-09)
- [x] Remote access: Tailscale + --host + token first, chat-bot bridge later? → yes, allow remote access, and document how to set it up for the users in the open-source project (decided 2026-07-09)

## Features

### Implementation queue

- [ ] yes, open-source it (without breaking my cockpit) — from: Open-source it? (license, name check, publish where — see checklist below)?
- [x] yes, allow remote access, and document how to set it up for the users in the open-source project — from: Remote access: Tailscale + --host + token first, chat-bot bridge later?

### Plan as command center

- [x] Plan card moved to the top; Git/Workspace/Deploy/Commits compacted below
- [x] every open ticket is a "work on this" button: confirm -> briefed Claude session in tmux impl window
- [x] server validates the ticket still exists and is open before launching; audit-logged as plan:work

### Actionable attention chips

- [x] chips are buttons: popup per chip explaining the situation
- [x] auto-fixes: pull --ff-only (confirm), create .project-cockpit.yml from template
- [x] agent-fix: "have Claude review & commit" — attended session in tmux commit window, never pushes
- [x] manual-by-design (push, upstream) get copyable commands + why-not-automated explanation
- [x] uncommitted popup shows the actual dirty files; submodules detected and explained (parent commit can't include them)
- [x] freshness indicator in footer ("updated Ns ago", turns yellow when stale) + refresh-now button

### Foundation links (contract with ai-foundation — separate repos, shared spec)

- [x] plan.md parser targets the versioned convention spec (`docs/plan-md-spec.md` v1.0 in ai-foundation); README states the version (2026-07-09)
- [x] foundation drift chip: reads `.ai/foundation-version.md`, finds the foundation repo among registered projects (no hardcoded path), compares manifest versions; fix modal shows read-only audit + additive onboard-refresh commands (2026-07-09)
- [x] add-project hand-off: registering an un-onboarded repo offers the onboard command in a modal — suggestion only, never run unasked (2026-07-09)
- [ ] one-click foundation refresh as a confirm-tier action once upgrade-project.sh exists (issue #8 in ai-foundation)
- [ ] asset-level drift in the chip detail (surface audit-project.sh --json output, not just version compare)

### Open-sourcing polish

- [ ] first-run empty state: welcome card on dashboard + friendly `cockpit list` when registry is empty
- [ ] genericize the 3 ai-foundation references in hint strings (inline a minimal config example)
- [ ] LICENSE (MIT) + README screenshots + install one-liner
- [ ] caveats section: macOS-only bits (open, launchd, iTerm2 -CC), agent detection is best-effort
- [ ] create GitHub repo and publish

### Remote access (Tier 1)

- [x] --host flag on the server (bind beyond 127.0.0.1)
- [x] bearer-token auth for non-localhost binds
- [x] phone-width responsive pass (collapsible sidebar)
- [x] document the Tailscale + SSH/tmux setup for iPad/phone
- [ ] connect-your-phone helper in the dashboard (tokened URL + QR) when a remote bind is active

### Cockpit v1.5 (carried from ai-foundation plan)

- [ ] checkbox toggling from the dashboard Plan card
- [ ] "open plan in Cursor/Obsidian" button
- [ ] macOS notifications for attention items (only if dashboard-glancing proves insufficient)

### Dashboard redesign (design notes 2026-07-10)

- [x] design tokens: neutral ramp, tinted page + borderless white cards (12px radius, shadow), semantic colors reserved for status; dark-mode variants
- [x] real type scale (11px uppercase micro-labels / 12 / 13 / 14 / 20) with tabular numerals; monospace only for code values
- [x] tickets & direction questions as truncated list rows with status marks (open circle / green check + dimmed) — strikethrough removed everywhere
- [x] emoji statuses (✳/✋) replaced by status dot + short label ("Working", "Waiting on you · 10m · 2 sessions")
- [x] attention chips as soft tinted amber pills; actions as aligned rows with uppercase tier badges and quiet run buttons
- [ ] hover tooltip is the only path to full ticket text — consider click-to-expand for touch devices (no hover on phones)
