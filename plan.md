# Plan

## Direction

- [x] Extract from ai-foundation to own repo? → yes, done with full git history via subtree split (decided 2026-07-07)
- [x] Open-source it? (license, name check, publish where — see checklist below) → yes, open-source it (without breaking my cockpit) (decided 2026-07-09)
- [x] Remote access: Tailscale + --host + token first, chat-bot bridge later? → yes, allow remote access, and document how to set it up for the users in the open-source project (decided 2026-07-09)
- [x] Monetize? → no: stays open-source/free; credibility first, not a few extra dollars (decided 2026-07-16)
- [x] Marketing & positioning: how to promote the cockpit and articulate what problem it solves (multi-project AI-assisted work needs one attention surface; observe-only + server-side safety tiers as the differentiator vs Vibe Island / Ping Island) → position one level above the crowded session-monitor category ("mission control for a portfolio of AI-assisted projects"); attention/safety/plan.md as the three pillars; essay-then-Show-HN launch sequence — full strategy + copy drafts: planning/marketing-positioning.md (decided 2026-07-16)

## Features

### Implementation queue

- [x] yes, open-source it (without breaking my cockpit) — from: Open-source it? (license, name check, publish where — see checklist below)? → public at github.com/earlyadopter/project-cockpit, MIT; local cockpit untouched (launchd dashboard + symlink verified running) (2026-07-16)
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
- [x] genericize the 3 ai-foundation references in hint strings (inline a minimal config example) (2026-07-16)
- [x] LICENSE (MIT) + README screenshots + install one-liner — screenshots from a COCKPIT_DIR demo registry, no real project data (2026-07-16)
- [x] caveats section: macOS-only bits (open, launchd, iTerm2 -CC), agent detection is best-effort — plus trust model and reboot behavior (2026-07-16)
- [x] create GitHub repo and publish → github.com/earlyadopter/project-cockpit, public (2026-07-16)

### Launch & promotion (strategy: planning/marketing-positioning.md)

- [x] demo GIF / 90s recording of the money loop (needs-you chip → what the agent asked → jump → plan decide → dispatch) at the top of the README — shares footage with the ai-foundation demo-asset ticket; record against the COCKPIT_DIR demo registry, not real projects → docs/demo.gif, 5 captioned scenes, 394 KB, staged demo world (decoy claude process + synthetic transcript), playwright-driven (2026-07-16)
- [ ] launch essay "Ten projects, one attention span" on earlyadopterlabs.com — workflow as the story, cockpit as the proof; cross-post DEV/X — draft ready (planning/launch-essay.md, incl. X-thread + DEV notes); remaining: owner review + publish to the site
- [ ] Show HN post (title + first-comment skeleton drafted in the strategy doc); be present in comments all day
- [ ] r/ClaudeAI + X thread same week, each natively reframed
- [ ] README: friendly comparison note vs the island apps ("session axis vs project axis") + submit to relevant GitHub topics (claude-code, agent-monitoring)
- [ ] opportunistic: pitch the hooks integration as a Claude Code hooks case study wherever community tooling is showcased

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

### Attention loop (borrowed ideas — planning/ideas-from-vibeisland-and-ping-island.md; sounds explicitly rejected: no audio, ever)

- [x] waiting-time escalation: sort needs-attention projects by longest agent wait; chip shows elapsed time and intensifies past 10m (idea 3) (2026-07-16)
- [x] show what the agent is waiting for: last assistant message excerpt in agent state, rendered in the waiting popup + Workspace card + `cockpit status`; doubles as completion summary (ideas 2+7) (2026-07-16)
- [x] precise focus return: `focusWindow()` in state.ts + `POST /api/focus` + jump button on the waiting chip; `cockpit go <p> -w <window>` (idea 4) (2026-07-16)
- [x] hook-based agent ingress: opt-in `cockpit hooks --install` writing Claude Code hook events to `~/.project-cockpit/agent-events.log`; `agentState()` prefers hook events, falls back to heuristics (idea 1) (2026-07-16)
- [x] compact attention-only `/focus` route: only projects needing you, for always-on-top window / phone over Tailscale (idea 5) (2026-07-16)
- [x] best-effort Claude quota visibility: `providerStatus()` header pill + warning before dispatch (idea 8) (2026-07-16)
- [x] per-project accent color/icon: optional `color:`/`icon:` in .project-cockpit.yml, hash-of-name fallback, dot in sidebar + `cockpit list` (idea 9) (2026-07-16)
- [ ] follow-up: escalation thresholds (10m amber→red) hardcoded — make configurable if they prove wrong in practice
- [ ] follow-up: hook ingress covers Claude Code only — Ping Island also ingests Gemini/Codex; add if those enter the workflow
- [x] follow-up: dashboard screenshot refresh in README once the new UI settles (accent dots, /focus view) (2026-07-16)

### Dashboard redesign (design notes 2026-07-10)

- [x] design tokens: neutral ramp, tinted page + borderless white cards (12px radius, shadow), semantic colors reserved for status; dark-mode variants
- [x] real type scale (11px uppercase micro-labels / 12 / 13 / 14 / 20) with tabular numerals; monospace only for code values
- [x] tickets & direction questions as truncated list rows with status marks (open circle / green check + dimmed) — strikethrough removed everywhere
- [x] emoji statuses (✳/✋) replaced by status dot + short label ("Working", "Waiting on you · 10m · 2 sessions")
- [x] attention chips as soft tinted amber pills; actions as aligned rows with uppercase tier badges and quiet run buttons
- [ ] hover tooltip is the only path to full ticket text — consider click-to-expand for touch devices (no hover on phones)
