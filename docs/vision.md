# Vision: the project cockpit

*The public version of the founding brief (2026-07-06) and the design direction that grew out of it. Phases 0–4 were built within days of the brief; this document records why the tool is shaped the way it is and where it's heading.*

## The problem

The cockpit exists because of a specific, modern kind of pain: working on **several AI-assisted projects at the same time** on one machine.

Each project is a repo, a branch, a set of terminal windows, a Cursor window, an Obsidian note, a local dev server, a deploy dashboard, environment files — and increasingly, one or more Claude Code sessions doing real work while you're elsewhere. None of those tools is deficient. The pain is between them:

- Terminal windows pile up with no reliable way to tell which belongs to which project.
- An agent finishes — or stalls at a permission prompt — and nothing announces it. Terminal tabs don't cry.
- Every project accumulates silent almost-decisions: uncommitted changes, unanswered direction questions, a dev server that quietly died.
- Switching projects costs a full context reload: *what was I doing here? what was the agent doing? what did we decide?*

The goal, verbatim from the founding brief: **reduce local cognitive load when working on multiple AI-assisted software projects, and drive more projects into products — not leave them hanging in indefinite state.**

## The diagnosis

This is not a terminal manager, not an agent runner, and not a kanban app. It's a **dev cockpit**: a project-first status-and-action surface that sits above the tools you already use. Session-level agent monitors answer "which of my agent sessions needs me?" — a useful question one level below this one. A *project* is more than its sessions: it has git state, a plan, services, deploys, and an owner whose attention is the scarcest input. The cockpit's unit is the project; its currency is attention.

## The shape of the answer

**One CLI + one localhost dashboard**, no daemon, no database, no cloud:

- **Named, recoverable workspaces.** One tmux session per project with standard windows (`dev` / `agent` / `shell`). The workspace is a desk with labeled drawers, not a robot: nothing runs in them by itself.
- **Live state, never cached.** Every request recomputes from `git`, `tmux`, `lsof`, and the filesystem. The only persistent state is a registry of project paths, an append-only audit log, and an auth token. A status tool that caches eventually lies, and a status tool that lies becomes decoration.
- **A per-repo `.project-cockpit.yml`** declaring services, links, and actions — optional; without it a project still gets git + tmux visibility.
- **plan.md as the command center.** Each repo carries its plan as plain markdown: `## Direction` questions (the decisions quietly keeping a project in limbo) and `## Features` with checkbox tickets. The dashboard renders it, lets you decide questions inline (with generated options for the hard ones), and turns tickets into briefed, attended agent sessions. The plan file is the context reload.

## The safety model (load-bearing, not advisory)

- **Tiered actions, enforced server-side.** `safe` runs on click; `confirm` requires explicit acknowledgment; `manual` is *never executed* — the server refuses and returns the command to copy. Push is manual in most projects because push means production deploy. The UI cannot weaken the tiers; everything is audit-logged.
- **Agents are observed, never driven.** The cockpit detects agent sessions (process + transcript traces, or precise opt-in hook events) and shows what they asked — but it will never answer for them. GUI approve/deny from a dashboard is an explicit anti-feature: approving a permission away from the terminal's full context is exactly how agents run wild. The only agent-starting path is an explicitly requested, fully attended session in the project's own tmux.
- **Localhost-first.** Binds `127.0.0.1` by default; any wider bind (for a phone over a private tailnet) enforces bearer-token auth on every request. Never exposed to the raw internet.

## The attention loop

The cockpit's defining feature set treats **waiting time as the real cost signal**:

- **Escalation.** A waiting agent shows its elapsed wait everywhere (`agent✋12m`), turns from amber to red as it ages, and the longest-waiting agent sorts first across all projects.
- **Show the ask.** The chip doesn't just say an agent is waiting — it shows *what the agent last said*: the question or completion summary, readable from the dashboard, so you can decide whether the context switch is worth it before paying for it.
- **Precise focus return.** One click lands you in the exact tmux window running the agent and raises the terminal. Focus only — it never types, sends, or approves anything.
- **Hook-based precision (opt-in).** Installing lightweight Claude Code hooks upgrades detection from transcript heuristics to exact events: "possibly waiting for permission" becomes the actual permission prompt text. Hooks report; they never drive.
- **The `/focus` view.** An attention-only slice of the dashboard — one row per project that needs you, "all quiet" otherwise — sized for an always-on-top sliver of screen or a phone bookmark.
- **Provider-limit awareness (best-effort).** If recent sessions show a rate/usage-limit error, the dashboard warns before dispatching new agent work into a stall.
- **Per-project identity.** A stable accent color and optional icon per project, so a sidebar of many projects can be scanned rather than read.

Deliberately rejected, and staying rejected: GUI permission approval, auto-approve toggles, sounds, and any feature that would make the dashboard drive an agent or quietly weaken a tier.

## What it avoids (from the brief, still true)

Kubernetes, multi-tenant SaaS, complex permissions, remote agent fleets, message buses, elaborate plugin systems, real-time collaboration, replacing the editor or the notes app, building a terminal emulator, and letting agents push or deploy without a human. The smallest local tool that gives immediate relief.

## Where it can grow

The phased roadmap that produced today's cockpit (conventions → CLI → dashboard → actions → agent visibility) has one deliberately deferred phase: **optional remote/cloud agent control**. The current remote story is intentionally modest — read-and-decide from a phone over a private tailnet, with the same tiers enforced. Anything more waits until the local loop has proven what's actually worth automating.
