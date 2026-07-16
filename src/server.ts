// cockpit dashboard — Phase 2 (read-only views) + Phase 3 (actions, palette, audit).
// One process, no daemon state: every request recomputes live state via state.ts.
// Tier enforcement lives HERE, server-side: safe runs, confirm needs an explicit
// confirmed flag (set by the UI dialog), manual is always refused with the command
// to copy. Non-GET requests must be same-origin. Binds 127.0.0.1 by default;
// --host binds wider (e.g. a Tailscale IP) and then EVERY request must carry the
// bearer token (see docs/remote-access.md).
// Start with `cockpit dash` or `bun src/server.ts [port] [--host <ip>]`.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { statSync } from "node:fs";
import {
  type Project,
  COCKPIT_DIR,
  accentColor, agentState, allProjects, answerDirection, attentionItems, audit, claudeCwds, cleanForPrompt,
  createConfigFromTemplate, discoverCandidates, findPlanningRefs, focusWindow, generateOptions,
  foundationSource, gitState, humanAge, lastPush, loadProject, loadRegistry, localService, openTarget,
  providerStatus, readFoundation,
  planStats, portListening, readAudit, readChangelog, readPlan, recentCommits,
  runInline, saveRegistry, sendToWindow, shA, shortAge, startAgentTask, startImplementation,
  tmuxSessionAlive, tmuxWindows,
} from "./state.ts";

async function projectSummary(p: Project, cwds: Awaited<ReturnType<typeof claudeCwds>>) {
  const svc = localService(p);
  const [git, session, devUp, agent] = await Promise.all([
    gitState(p.root),
    tmuxSessionAlive(p.name),
    svc?.port ? portListening(svc.port) : Promise.resolve(null),
    agentState(p, cwds),
  ]);
  const plan = readPlan(p);
  const foundation = readFoundation(p);
  const accent = accentColor(p);
  return {
    name: p.name, root: p.root, focus: p.cfg.focus ?? "", branch: git.branch,
    dirty: git.dirty.length, ahead: git.ahead, behind: git.behind,
    session, devPort: svc?.port ?? null, devUp,
    agent: { ...agent, age: humanAge(agent.ageSec), wait: shortAge(agent.ageSec) },
    color: accent.css, icon: accent.icon,
    plan, planStats: plan ? planStats(plan) : null,
    foundation,
    attention: attentionItems(p, git, agent, plan, foundation),
  };
}

async function projectDetail(p: Project) {
  const cwds = await claudeCwds();
  const [summary, git, windows, push, commits] = await Promise.all([
    projectSummary(p, cwds),
    gitState(p.root),
    tmuxWindows(p.name),
    lastPush(p.root),
    recentCommits(p.root, 10),
  ]);
  const services = await Promise.all(
    (p.cfg.services ?? []).map(async (s) => ({
      ...s,
      up: s.port ? await portListening(s.port) : null,
    })),
  );
  const changelog = readChangelog(p);
  const provider = providerStatus();
  // Dirty paths that are submodules (gitlinks): a parent-repo commit cannot
  // include their inner changes — the UI must say so.
  const gitlinks = new Set(
    (await shA("git", ["-C", p.root, "ls-files", "-s"])).out.split("\n")
      .filter((l) => l.startsWith("160000")).map((l) => l.split("\t")[1]),
  );
  const dirtyPath = (l: string) => l.trim().replace(/^\S{1,2}\s+/, "");
  const submodulesDirty = git.dirty
    .map(dirtyPath)
    .filter((path) => gitlinks.has(path));
  return {
    ...summary,
    repo: p.cfg.repo ?? "", notes: p.cfg.notes ?? "", hasConfig: p.hasConfig,
    lastCommit: git.lastCommit, lastCommitAge: git.lastCommitAge,
    hasUpstream: git.hasUpstream, hasRemote: git.hasRemote,
    dirtyFiles: git.dirty.slice(0, 20), dirtyTotal: git.dirty.length, submodulesDirty,
    windows, lastPush: push, commits, services, provider,
    envFiles: (p.cfg.env_files ?? []).map((f) => ({ path: f, exists: existsSync(join(p.root, f)) })),
    actions: Object.entries(p.cfg.actions ?? {}).map(([name, a]) => ({
      name, cmd: a.cmd, tier: a.tier ?? "safe", window: a.window ?? null,
    })),
    changelog,
  };
}

function getProject(name: string): Project | undefined {
  const q = decodeURIComponent(name).toLowerCase();
  return allProjects().find((x) => x.name.toLowerCase() === q);
}

// ---------- remote access: bind host + bearer token ----------
// Non-loopback binds require a token on EVERY request (this dashboard runs
// commands — see docs/remote-access.md). The token persists across restarts in
// ~/.project-cockpit/token so launchd installs and phone bookmarks keep working.
const TOKEN_FILE = join(COCKPIT_DIR, "token");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function loadOrCreateToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  }
  const t = randomBytes(24).toString("base64url");
  mkdirSync(COCKPIT_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}

function tokenMatches(given: string | null | undefined, want: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ServerOpts { host?: string; token?: string }

export function startServer(port = 4400, opts: ServerOpts = {}) {
  const host = opts.host || "127.0.0.1";
  const loopbackOnly = LOOPBACK_HOSTS.has(host);
  // Loopback binds stay friction-free (no token unless one is passed explicitly);
  // any wider bind refuses to start without one.
  const token = opts.token || process.env.COCKPIT_TOKEN || (loopbackOnly ? null : loadOrCreateToken());
  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

      if (token) {
        const cookieTok = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)cockpit_token=([^;]+)/)?.[1];
        const authHdr = req.headers.get("authorization");
        const bearer = authHdr?.startsWith("Bearer ") ? authHdr.slice(7) : null;
        if (!tokenMatches(bearer, token) && !tokenMatches(cookieTok, token)) {
          // One-time login URL: GET /?token=… (or /focus?token=…) sets the session
          // cookie, then redirects to a clean path so the token doesn't linger.
          if (req.method === "GET" && ["/", "/focus"].includes(url.pathname) && tokenMatches(url.searchParams.get("token"), token)) {
            return new Response(null, {
              status: 303,
              headers: {
                location: url.pathname,
                "set-cookie": `cockpit_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
              },
            });
          }
          if (url.pathname.startsWith("/api/")) return json({ error: "unauthorized — send Authorization: Bearer <token>" }, 401);
          return new Response("401 unauthorized — open the tokened URL printed by `cockpit dash` (http://…/?token=…)", { status: 401 });
        }
      } else {
        // No token means loopback-only. Refuse requests whose Host header isn't
        // local — blocks DNS-rebinding tricks against the tokenless localhost bind.
        const reqHost = url.hostname;
        if (!LOOPBACK_HOSTS.has(reqHost)) return json({ error: "loopback only" }, 403);
      }

      // Same-origin guard for anything that mutates.
      if (req.method !== "GET") {
        const origin = req.headers.get("origin");
        if (origin && new URL(origin).host !== url.host) return json({ error: "cross-origin request refused" }, 403);
      }

      if (req.method === "GET" && url.pathname === "/api/projects") {
        const cwds = await claudeCwds();
        const projects = await Promise.all(allProjects().map((p) => projectSummary(p, cwds)));
        // needs-attention first; within those, longest-waiting agent on top —
        // waiting time is the real cost signal when juggling many projects
        const waitSec = (p: (typeof projects)[number]) => (p.agent.state === "waiting" ? p.agent.ageSec ?? 0 : -1);
        projects.sort((a, b) =>
          (b.attention.length ? 1 : 0) - (a.attention.length ? 1 : 0) ||
          waitSec(b) - waitSec(a) ||
          a.name.localeCompare(b.name));
        return json(projects);
      }

      const m = url.pathname.match(/^\/api\/project\/(.+)$/);
      if (req.method === "GET" && m) {
        const p = getProject(m[1]);
        if (!p) return json({ error: "not found" }, 404);
        return json(await projectDetail(p));
      }

      if (req.method === "GET" && url.pathname === "/api/candidates") {
        return json(discoverCandidates());
      }

      if (req.method === "POST" && url.pathname === "/api/add") {
        const body = await req.json().catch(() => ({}));
        let path = String(body.path ?? "").trim();
        if (!path) return json({ error: "path required" }, 400);
        if (path.startsWith("~")) path = homedir() + path.slice(1);
        path = resolve(path).replace(/\/$/, "");
        try {
          if (!statSync(path).isDirectory()) return json({ error: "not a directory" }, 400);
        } catch {
          return json({ error: `no such directory: ${path}` }, 400);
        }
        const paths = loadRegistry();
        const name = loadProject(path).name;
        if (paths.includes(path)) return json({ ok: true, already: true, path, name });
        paths.push(path);
        saveRegistry(paths);
        audit(name, "add", "safe", `${path} [dash]`);
        // Foundation hand-off: if the repo isn't onboarded and the foundation
        // repo is registered, suggest the onboard command (never run it unasked).
        let onboardHint: string | null = null;
        if (!existsSync(join(path, ".ai", "foundation-version.md"))) {
          const src = foundationSource();
          if (src) onboardHint = `${src.scripts}/onboard-project.sh ${path}`;
        }
        return json({ ok: true, path, name, onboardHint });
      }

      if (req.method === "POST" && url.pathname === "/api/plan/answer") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const question = String(body.question ?? "").trim();
        const answer = String(body.answer ?? "").trim();
        if (!question || !answer) return json({ error: "question and answer required" }, 400);
        const r = answerDirection(p, question, answer);
        if (!r.ok) return json({ error: r.error }, 400);
        audit(p.name, "plan:answer", "safe", `${question.slice(0, 60)} → ${answer.slice(0, 60)} [dash]`);
        return json({ ok: true });
      }

      if (req.method === "GET" && url.pathname === "/api/plan/hints") {
        const p = getProject(url.searchParams.get("project") ?? "");
        if (!p) return json({ error: "unknown project" }, 404);
        return json({ refs: findPlanningRefs(p, url.searchParams.get("question") ?? "") });
      }

      if (req.method === "POST" && url.pathname === "/api/plan/options") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const question = String(body.question ?? "").trim();
        if (!question) return json({ error: "question required" }, 400);
        audit(p.name, "plan:options", "safe", question.slice(0, 80) + " [dash]");
        const r = await generateOptions(p, question);
        if (r.error) return json({ error: r.error }, 500);
        return json(r);
      }

      // --- one-click fixes for attention chips ---
      if (req.method === "POST" && url.pathname === "/api/fix/pull") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const r = runInline(p, "git pull --ff-only");
        audit(p.name, "fix:pull", "confirm", `exit=${r.status} [dash]`);
        return json({ ok: r.status === 0, status: r.status, output: r.output });
      }

      if (req.method === "POST" && url.pathname === "/api/fix/config") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const r = createConfigFromTemplate(p);
        if (!r.ok) return json({ error: r.error }, 400);
        audit(p.name, "fix:config", "safe", ".project-cockpit.yml created [dash]");
        return json({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/fix/commit-agent") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const brief = "This repo has uncommitted changes. Run git status and git diff, group the changes into one or more sensible commits with clear messages, and commit them. Ignore generated artifacts (add to .gitignore if obviously generated). Do NOT push.";
        const r = await startAgentTask(p, brief, "commit");
        if (!r.ok) return json({ error: r.error }, 500);
        audit(p.name, "fix:commit-agent", "confirm", "claude session in tmux:commit [dash]");
        return json({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/plan/work") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const feature = String(body.feature ?? "").trim();
        const ticket = String(body.ticket ?? "").trim();
        const plan = readPlan(p);
        const f = plan?.features.find((x) => x.name === feature);
        const t = f?.tickets.find((x) => x.text === ticket && !x.done);
        if (!t) return json({ error: "ticket not found or already done (plan.md changed?)" }, 404);
        const brief = `In plan.md, under the feature '${cleanForPrompt(feature)}', there is an open ticket: '${cleanForPrompt(ticket)}'. Read plan.md and the relevant code for context, briefly state your plan, then implement this ticket. Check its box in plan.md when done, and add follow-up tickets you discover. Do NOT push.`;
        const r = await startAgentTask(p, brief, "impl");
        if (!r.ok) return json({ error: r.error }, 500);
        audit(p.name, "plan:work", "confirm", `${ticket.slice(0, 70)} [dash]`);
        return json({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/plan/implement") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const question = String(body.question ?? "").trim();
        const answer = String(body.answer ?? "").trim();
        if (!question || !answer) return json({ error: "question and answer required" }, 400);
        const r = await startImplementation(p, question, answer);
        if (!r.ok) return json({ error: r.error }, 500);
        audit(p.name, "plan:implement", "confirm", `${answer.slice(0, 60)} [dash]`);
        return json({ ok: true });
      }

      // Focus-only: selects the tmux window that needs you and raises the
      // terminal. Never starts or sends anything — the observe-only invariant.
      if (req.method === "POST" && url.pathname === "/api/focus") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const r = await focusWindow(p, body.window ? String(body.window) : undefined);
        if (!r.ok) return json({ error: r.error }, 400);
        audit(p.name, "focus", "safe", `window=${r.window}${r.attached ? "" : " (no attached client)"} [dash]`);
        return json(r);
      }

      if (req.method === "GET" && url.pathname === "/api/audit") {
        return new Response(readAudit(), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      if (req.method === "POST" && url.pathname === "/api/open") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const r = openTarget(p, String(body.target ?? ""));
        if (!r.ok) return json({ error: r.error }, 400);
        audit(p.name, `open:${body.target}`, "safe", `${r.result} [dash]`);
        return json({ ok: true, result: r.result });
      }

      if (req.method === "POST" && url.pathname === "/api/run") {
        const body = await req.json().catch(() => ({}));
        const p = getProject(String(body.project ?? ""));
        if (!p) return json({ error: "unknown project" }, 404);
        const name = String(body.action ?? "");
        const action = (p.cfg.actions ?? {})[name];
        if (!action?.cmd) return json({ error: `unknown action "${name}"` }, 404);
        const tier = action.tier ?? "safe";

        if (tier === "manual") {
          audit(p.name, name, tier, "refused-manual-tier [dash]");
          return json({ refused: true, tier, cmd: `cd ${p.root}\n${action.cmd}` }, 403);
        }
        if (tier === "confirm" && body.confirmed !== true) {
          return json({ needsConfirm: true, tier, cmd: action.cmd }, 409);
        }
        if (action.window) {
          await sendToWindow(p, action.window, action.cmd);
          audit(p.name, name, tier, `sent-to-tmux:${action.window} [dash]`);
          return json({ ok: true, sentToWindow: action.window });
        }
        const r = runInline(p, action.cmd);
        audit(p.name, name, tier, `exit=${r.status} [dash]`);
        return json({ ok: r.status === 0, status: r.status, output: r.output });
      }

      if (req.method === "GET" && url.pathname === "/") {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && url.pathname === "/focus") {
        return new Response(FOCUS_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  if (token) {
    console.log(`cockpit dashboard: http://${loopbackOnly ? "localhost" : host}:${server.port} (Ctrl-C to stop)`);
    console.log(`  token required — open once with: http://${loopbackOnly ? "localhost" : "<this-machine>"}:${server.port}/?token=${token}`);
    console.log(`  (token file: ${TOKEN_FILE} — API calls can send Authorization: Bearer <token>)`);
  } else {
    console.log(`cockpit dashboard: http://localhost:${server.port} (Ctrl-C to stop)`);
  }
  return server;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cockpit</title>
<style>
  /* Design tokens — 5-step neutral ramp, one accent, semantic colors for status only. */
  :root {
    --bg: #f4f3f0; --surface: #ffffff;
    --line: rgba(26,32,41,.07); --border: rgba(26,32,41,.14);
    --ink: #1a2029; --ink-2: #5b6572; --ink-3: #8a93a0;
    --accent: #2563eb;
    --ok: #177a3b; --ok-bg: #e7f4eb;
    --warn-ink: #8a5a00; --warn-bg: #f9efd8;
    --bad: #b42318; --bad-bg: #fdecea;
    --chip-bg: #f0efeb; --overlay: rgba(26,32,41,.45);
    --shadow: 0 1px 2px rgba(26,32,41,.05), 0 2px 6px rgba(26,32,41,.04);
    --radius: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12161b; --surface: #1c222a;
      --line: rgba(232,236,241,.07); --border: rgba(232,236,241,.16);
      --ink: #e8ecf1; --ink-2: #a6b0bc; --ink-3: #6f7a87;
      --accent: #6ea8fe;
      --ok: #4ade80; --ok-bg: rgba(74,222,128,.13);
      --warn-ink: #f2c94c; --warn-bg: rgba(242,201,76,.13);
      --bad: #f87171; --bad-bg: rgba(248,113,113,.13);
      --chip-bg: #262d36; --overlay: rgba(0,0,0,.55);
      --shadow: inset 0 0 0 1px var(--line);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; background: var(--bg); color: var(--ink); }
  .layout { display: flex; min-height: 100vh; }
  aside { width: 250px; flex: none; border-right: 1px solid var(--line); background: var(--surface); padding: 12px 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; }
  aside h1 { font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); margin: 6px 16px 10px; }
  aside .grow { flex: 1; }
  aside .foot { padding: 10px 16px; font-size: 12px; color: var(--ink-3); border-top: 1px solid var(--line); }
  aside .foot button { background: none; border: 0; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }
  .proj { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--ink); padding: 9px 16px; cursor: pointer; font: inherit; border-left: 3px solid transparent; }
  .proj:hover { background: var(--chip-bg); }
  .proj.sel { border-left-color: var(--accent); background: var(--chip-bg); }
  .proj .nm { font-weight: 600; display: flex; align-items: center; gap: 7px; }
  .proj .sub { color: var(--ink-2); font-size: 12px; margin-left: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn-ink); }
  /* per-project accent — identity, not status (square so it can't be misread as a status dot) */
  .pdot { width: 6px; height: 6px; border-radius: 2px; flex: none; display: inline-block; }
  .attnbtn.hot { background: var(--bad-bg); color: var(--bad); }
  .lastmsg { color: var(--ink-2); font-style: italic; margin-top: 4px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
  .quota { background: var(--bad-bg); color: var(--bad); border-radius: 999px; padding: 3px 12px; font-size: 12px; font-weight: 500; display: inline-block; margin: 6px 0 0; }
  /* status dot + short label — the only place semantic color is used as signal */
  .stat { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; white-space: nowrap; }
  .sdot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
  .sdot.ok { background: var(--ok); } .sdot.warn { background: var(--warn-ink); } .sdot.mut { background: var(--ink-3); } .sdot.bad { background: var(--bad); }
  /* mobile top bar + collapsible sidebar */
  .mtop { display: none; }
  #scrim { display: none; position: fixed; inset: 0; background: var(--overlay); z-index: 15; }
  @media (max-width: 720px) {
    .mtop { display: flex; align-items: center; gap: 10px; position: sticky; top: 0; z-index: 5; background: var(--surface); box-shadow: var(--shadow); padding: 10px 14px; font-weight: 600; }
    .mtop button { background: none; border: 0; font-size: 18px; line-height: 1; color: var(--ink); cursor: pointer; padding: 2px 6px; }
    .mtop .cur { color: var(--ink-3); font-weight: 400; margin-left: auto; font-size: 12px; }
    .layout { display: block; min-height: auto; }
    aside { position: fixed; top: 0; left: 0; bottom: 0; height: 100vh; width: min(300px, 82vw); z-index: 20; transform: translateX(-105%); transition: transform .18s ease; box-shadow: 0 0 40px rgba(0,0,0,.25); }
    aside.open { transform: none; }
    #scrim.show { display: block; }
    main { padding: 14px 14px 24px; }
    header h2 { font-size: 18px; }
    .ansline input { max-width: 56vw; }
  }
  main { flex: 1; padding: 22px 26px; min-width: 0; }
  header .path { color: var(--ink-3); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header h2 { margin: 2px 0 2px; font-size: 20px; font-weight: 600; }
  .focus { color: var(--ink-2); margin: 0 0 10px; }
  .links { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 4px; }
  .links a, .links button { text-decoration: none; color: var(--accent); background: var(--surface); border: 1px solid var(--border); padding: 4px 12px; border-radius: 999px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .links a:hover, .links button:hover { border-color: var(--accent); }
  .attn { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
  .attnbtn { background: var(--warn-bg); color: var(--warn-ink); border: 0; padding: 5px 13px; border-radius: 999px; font-size: 12.5px; font-weight: 500; font-family: inherit; cursor: pointer; }
  .attnbtn:hover { box-shadow: inset 0 0 0 1px var(--warn-ink); }
  .attnbtn .chev { margin-left: 6px; opacity: .6; }
  .fixcmd { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .fixcmd code { background: var(--chip-bg); border-radius: 6px; padding: 5px 10px; flex: 1; overflow-x: auto; white-space: nowrap; }
  .calm { color: var(--ink-2); font-size: 13px; margin: 14px 0; display: flex; align-items: center; gap: 7px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 1fr)); gap: 14px; margin-top: 10px; }
  .cards.small { grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); }
  .cards.small details { font-size: 12px; }
  .cards.small summary { padding: 10px 14px; font-size: 13px; }
  .cards.small .body { padding: 0 14px 12px; }
  .cards.small pre { max-height: 170px; font-size: 11px; }
  .cards.small .commit { font-size: 12px; }
  details.card { background: var(--surface); border-radius: var(--radius); padding: 0; overflow: hidden; box-shadow: var(--shadow); }
  details.wide { grid-column: 1 / -1; }
  summary { cursor: pointer; padding: 12px 16px; font-size: 14px; font-weight: 500; list-style: none; display: flex; align-items: center; gap: 8px; user-select: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "▸"; color: var(--ink-3); font-size: 10px; transition: transform .12s; }
  details[open] summary::before { transform: rotate(90deg); }
  summary .hint { font-weight: 400; color: var(--ink-3); font-size: 12px; margin-left: auto; }
  .body { padding: 2px 16px 14px; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 3px 10px 3px 0; vertical-align: top; }
  td.k { color: var(--ink-2); white-space: nowrap; width: 1%; }
  .mono, pre, code { font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
  pre { background: var(--chip-bg); border-radius: 8px; padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; max-height: 340px; overflow-y: auto; }
  .ok-t { color: var(--ok); } .bad-t { color: var(--bad); } .mut { color: var(--ink-3); }
  .tier { font-size: 10.5px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; flex: none; }
  .tier.safe { color: var(--ok); background: var(--ok-bg); } .tier.confirm { color: var(--warn-ink); background: var(--warn-bg); } .tier.manual { color: var(--bad); background: var(--bad-bg); }
  .commit { display: flex; gap: 10px; padding: 3px 0; align-items: baseline; min-width: 0; }
  .commit .s { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .commit .h { color: var(--ink-3); flex: none; } .commit .a { color: var(--ink-3); margin-left: auto; flex: none; font-size: 12px; }
  /* actions: aligned rows — name · command · tier badge · quiet button */
  .act { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); min-width: 0; }
  .act:first-child { border-top: 0; }
  .act .an { font-weight: 500; flex: none; min-width: 92px; }
  .act code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--chip-bg); border-radius: 5px; padding: 2px 8px; color: var(--ink-2); }
  .act .win { flex: none; color: var(--ink-3); font-size: 12px; }
  footer { color: var(--ink-3); font-size: 12px; margin-top: 18px; }
  .empty { color: var(--ink-3); padding: 40px; text-align: center; }
  .runbtn { font: 12px inherit; padding: 3px 12px; border-radius: 7px; border: 1px solid var(--border); background: none; color: var(--ink-2); cursor: pointer; flex: none; }
  .runbtn:hover { border-color: var(--accent); color: var(--accent); }
  .runbtn:disabled { opacity: .5; cursor: wait; }
  kbd { font: 11px ui-monospace, Menlo, monospace; background: var(--chip-bg); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; }
  #palette, #addmodal, #hintmodal, #fixmodal { position: fixed; inset: 0; background: var(--overlay); display: none; z-index: 30; }
  #palette.open, #addmodal.open, #hintmodal.open, #fixmodal.open { display: block; }
  #fixmodal .box { margin: 12vh auto 0; background: var(--surface); border-radius: var(--radius); overflow: hidden; box-shadow: 0 18px 50px rgba(0,0,0,.3); max-height: 76vh; display: flex; flex-direction: column; }
  #palette .box, #addmodal .box { width: min(560px, 90vw); margin: 12vh auto 0; background: var(--surface); border-radius: var(--radius); overflow: hidden; box-shadow: 0 18px 50px rgba(0,0,0,.3); }
  #hintmodal .box { width: min(1100px, 94vw); margin: 5vh auto 0; background: var(--surface); border-radius: var(--radius); overflow: hidden; box-shadow: 0 18px 50px rgba(0,0,0,.3); display: flex; flex-direction: column; max-height: 88vh; }
  #hintmodal .items { max-height: none; overflow-y: auto; flex: 1; }
  #hintmodal pre { margin: 4px 0 8px; max-height: 48vh; }
  .optitem { border-top: 1px solid var(--line); padding: 10px 12px; border-radius: 8px; cursor: pointer; position: relative; }
  .optitem:hover { background: var(--chip-bg); }
  .optitem .tick { position: absolute; right: 12px; top: 10px; color: var(--accent); font-weight: 700; visibility: hidden; }
  .optitem.sel { background: var(--chip-bg); outline: 2px solid var(--accent); outline-offset: -2px; }
  .optitem.sel .tick { visibility: visible; }
  #hintfoot { border-top: 1px solid var(--line); padding: 10px 16px; display: flex; align-items: center; gap: 12px; flex: none; }
  #hintfoot .expl { color: var(--ink-3); font-size: 12px; line-height: 1.4; }
  #palette input, #addmodal input { width: 100%; border: 0; outline: 0; background: none; color: var(--ink); font: 16px inherit; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  #palette .items, #addmodal .items { max-height: 46vh; overflow-y: auto; }
  #palette .item, #addmodal .item { padding: 9px 16px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
  #palette .item.hot, #palette .item:hover, #addmodal .item:hover { background: var(--chip-bg); }
  #palette .item .k2, #addmodal .item .k2 { color: var(--ink-3); font-size: 12px; margin-left: auto; flex: none; }
  #addmodal .hdr { padding: 8px 16px 4px; color: var(--ink-3); font-size: 12px; }
  .plansec { font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); margin: 12px 0 4px; }
  .plq { padding: 4px 0; display: flex; align-items: center; gap: 9px; flex-wrap: wrap; min-width: 0; }
  .plq .qt { flex: 1; min-width: 220px; }
  .plq.done { color: var(--ink-3); flex-wrap: nowrap; }
  .plq.done .qt { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ansline { display: inline-flex; gap: 6px; align-items: center; margin-left: auto; }
  .ansline input { width: 300px; max-width: 40vw; font: 12.5px inherit; color: var(--ink); background: var(--chip-bg); border: 1px solid transparent; border-radius: 6px; padding: 3px 9px; outline: none; }
  .ansline input:focus { border-color: var(--accent); }
  .feat { padding: 8px 0; border-top: 1px solid var(--line); }
  .feat:first-of-type { border-top: 0; }
  .feat.done .fhead { color: var(--ink-3); }
  .fhead { font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .fprog { margin-left: auto; display: flex; align-items: center; gap: 7px; font-weight: 400; font-size: 12px; color: var(--ink-3); }
  .fbar { width: 90px; height: 5px; border-radius: 3px; background: var(--chip-bg); overflow: hidden; display: inline-block; }
  .fbar > span { display: block; height: 100%; background: var(--accent); }
  /* tickets: truncated list rows with status marks — full text on hover; never strikethrough */
  .ftickets { margin-top: 4px; }
  .trow { display: flex; align-items: center; gap: 9px; width: 100%; padding: 5px 4px; border: 0; border-top: 1px solid var(--line); background: none; color: var(--ink); font: inherit; text-align: left; border-radius: 6px; min-width: 0; }
  .trow:first-child { border-top: 0; }
  .trow .tt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trow.done { color: var(--ink-3); }
  button.trow { cursor: pointer; }
  button.trow:hover { background: var(--chip-bg); }
  .oc { flex: none; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--ink-3); }
  .ck { flex: none; color: var(--ok); font-size: 12px; width: 11px; text-align: center; }
</style>
</head>
<body>
<div class="mtop"><button onclick="toggleSide()" aria-label="projects menu">☰</button><span>cockpit</span><span class="cur" id="mcur"></span></div>
<div id="scrim" onclick="toggleSide(false)"></div>
<div class="layout">
  <aside id="aside">
    <h1>Projects</h1><div id="side"></div>
    <button class="proj" onclick="openAdd()" style="color:var(--accent)">＋ Add project…</button>
    <div class="grow"></div>
    <div class="foot"><button onclick="openPalette()">⌘K command palette</button> · <button onclick="toggleAudit()">audit log</button></div>
  </aside>
  <main id="main"><div class="empty">Loading…</div></main>
</div>
<div id="palette" onclick="if(event.target===this)closePalette()">
  <div class="box">
    <input id="palq" placeholder="Switch project, open, or run an action…" autocomplete="off">
    <div class="items" id="palitems"></div>
  </div>
</div>
<div id="fixmodal" onclick="if(event.target===this)closeFix()">
  <div class="box" style="width:min(640px,92vw)">
    <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-weight:600" id="fixtitle"></div>
    <div id="fixbody" style="padding:14px 16px;overflow-y:auto"></div>
  </div>
</div>
<div id="hintmodal" onclick="if(event.target===this)closeHints()">
  <div class="box">
    <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-weight:600" id="hinttitle"></div>
    <div class="items" id="hintbody"></div>
    <div id="hintfoot">
      <button class="runbtn" id="usebtn" onclick="useSelected()" disabled>use selected → answer field</button>
      <span class="expl">Selecting here only fills the answer field — nothing runs. Then <strong>decide</strong> writes the decision + a ticket to plan.md, and you'll be asked whether to start implementation (a Claude Code session in this project's tmux) or leave it queued for later.</span>
    </div>
  </div>
</div>
<div id="addmodal" onclick="if(event.target===this)closeAdd()">
  <div class="box">
    <input id="addpath" placeholder="Path to the project folder, e.g. ~/projects/my-app" autocomplete="off"
      onkeydown="if(event.key==='Enter')submitAdd(this.value); if(event.key==='Escape')closeAdd()">
    <div class="items" id="addcands"></div>
  </div>
</div>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const dirtyPath = (l) => l.trim().replace(/^\\S{1,2}\\s+/, "");
let selected = decodeURIComponent(location.hash.slice(1)) || null;
let openState = {};
let projectsCache = [];
let detailCache = null;
let auditShown = false;

function rememberOpen() {
  document.querySelectorAll("main details[id]").forEach((d) => { openState[d.id] = d.open; });
}
function card(id, title, hint, bodyHtml, wide) {
  const open = openState[id] !== undefined ? openState[id] : true;
  return \`<details class="card \${wide ? "wide" : ""}" id="\${id}" \${open ? "open" : ""}>
    <summary>\${esc(title)}\${hint ? \`<span class="hint">\${esc(hint)}</span>\` : ""}</summary>
    <div class="body">\${bodyHtml}</div></details>\`;
}

function toggleSide(force) {
  const open = force !== undefined ? force : !document.getElementById("aside").classList.contains("open");
  document.getElementById("aside").classList.toggle("open", open);
  document.getElementById("scrim").classList.toggle("show", open);
}

async function refresh() {
  projectsCache = await (await fetch("/api/projects")).json();
  if (!selected && projectsCache.length) selected = projectsCache[0].name;
  document.getElementById("side").innerHTML = projectsCache.map((p) => {
    // waiting escalates with elapsed time: amber, then red past 10 minutes
    const hot = p.agent.state === "waiting" && (p.agent.ageSec ?? 0) >= 600;
    const agent = p.agent.state === "working" ? ' · <span class="stat" style="font-size:12px"><span class="sdot ok"></span>agent</span>'
      : p.agent.state === "waiting" ? \` · <span class="stat" style="font-size:12px;color:var(--\${hot ? "bad" : "warn-ink"})"><span class="sdot \${hot ? "bad" : "warn"}"></span>needs you\${p.agent.wait ? " · " + esc(p.agent.wait) : ""}</span>\` : "";
    return \`
    <button class="proj \${p.name === selected ? "sel" : ""}" onclick="pick('\${esc(p.name)}')">
      <div class="nm"><span class="dot \${p.attention.length ? "warn" : "ok"}"></span><span class="pdot" style="background:\${esc(p.color)}"></span>\${p.icon ? esc(p.icon) + " " : ""}\${esc(p.name)}</div>
      <div class="sub">\${esc(p.branch || "—")}\${p.session ? " · tmux" : ""}\${p.devUp ? " · :" + p.devPort : ""}\${agent}\${p.attention.length ? \` · <span style="color:var(--warn-ink)">\${p.attention.length} to review</span>\` : ""}</div>
    </button>\`;
  }).join("");
  const mcur = document.getElementById("mcur");
  if (mcur) mcur.textContent = selected || "";
  if (selected) renderDetail();
}

function pick(name) { selected = name; location.hash = encodeURIComponent(name); openState = {}; toggleSide(false); refresh(); }

async function openIn(target) {
  const r = await fetch("/api/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected, target }) });
  const d = await r.json();
  if (!r.ok) alert(d.error || "failed");
}

async function runAction(name, confirmed = false) {
  const btn = document.getElementById("act-" + name);
  if (btn) { btn.disabled = true; btn.textContent = "running…"; }
  const r = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected, action: name, confirmed }) });
  const d = await r.json();
  if (btn) { btn.disabled = false; btn.textContent = "run"; }
  if (d.needsConfirm) {
    if (confirm('Run "' + d.cmd + '" in ' + selected + "?")) return runAction(name, true);
    setRunOut(name, "declined", "");
    return;
  }
  if (d.refused) { setRunOut(name, "manual tier — copy the command instead", d.cmd); return; }
  if (d.sentToWindow) { setRunOut(name, "sent to tmux window “" + d.sentToWindow + "”", ""); return; }
  setRunOut(name, "exit " + d.status, d.output || "");
  refresh();
}

function setRunOut(name, headline, body) {
  const el = document.getElementById("runout");
  if (!el) return;
  el.innerHTML = \`<div style="margin-top:8px"><strong class="mono">\${esc(name)}</strong> <span class="mut">— \${esc(headline)}</span>\${body ? \`<pre>\${esc(body)}</pre>\` : ""}</div>\`;
}

function copyCmd(text, btn) {
  navigator.clipboard.writeText(text).then(() => { btn.textContent = "copied ✓"; setTimeout(() => (btn.textContent = "copy"), 1500); });
}

async function toggleAudit() {
  auditShown = !auditShown;
  if (auditShown) {
    const text = await (await fetch("/api/audit")).text();
    document.getElementById("main").insertAdjacentHTML("afterbegin",
      \`<details class="card wide" id="auditcard" open style="margin-bottom:14px"><summary>Audit log<span class="hint">last 200</span></summary><div class="body"><pre>\${esc(text || "(empty)")}</pre></div></details>\`);
  } else {
    document.getElementById("auditcard")?.remove();
  }
}

async function renderDetail() {
  // don't clobber an answer being typed or an open hints popup
  const ae = document.activeElement;
  if (ae && ae.tagName === "INPUT" && ae.id.startsWith("ansin-") ) return;
  if (document.getElementById("hintmodal")?.classList.contains("open")) return;
  if (document.getElementById("fixmodal")?.classList.contains("open")) return;
  const anyAnswer = [...document.querySelectorAll('input[id^="ansin-"]')].some((el) => el.value.trim());
  if (anyAnswer) return;
  const r = await fetch("/api/project/" + encodeURIComponent(selected));
  if (!r.ok) { document.getElementById("main").innerHTML = '<div class="empty">Project not found</div>'; return; }
  const d = await r.json();
  detailCache = d;
  rememberOpen();
  const runOutHtml = document.getElementById("runout")?.innerHTML ?? "";

  const links = [
    d.repo && \`<a href="\${esc(d.repo)}" target="_blank">GitHub ↗</a>\`,
    ...(d.services || []).filter((s) => s.url && s.kind !== "local").map((s) => \`<a href="\${esc(s.url)}" target="_blank">\${esc(s.name || s.kind)} ↗</a>\`),
    ...(d.services || []).filter((s) => s.url && s.kind === "local").map((s) => \`<a href="\${esc(s.url)}" target="_blank">local dev ↗</a>\`),
    d.notes && \`<button onclick="openIn('obsidian')">Obsidian ↗</button>\`,
    \`<button onclick="openIn('cursor')">Cursor ↗</button>\`,
    \`<button onclick="openIn('finder')">Finder ↗</button>\`,
  ].filter(Boolean).join("");

  const agentHot = d.agent.state === "waiting" && (d.agent.ageSec ?? 0) >= 600;
  const attn = d.attention.length
    ? \`<div class="attn">\${d.attention.map((a, ai) => \`<button class="attnbtn \${agentHot && /^agent waiting/.test(a) ? "hot" : ""}" onclick="openFix(\${ai})">\${esc(a)}<span class="chev">›</span></button>\`).join("")}</div>\`
    : \`<div class="calm"><span class="sdot ok"></span>all clear</div>\`;

  const gitBody = d.branch ? \`<table>
      <tr><td class="k">branch</td><td class="mono">\${esc(d.branch)}\${d.hasUpstream ? \` <span class="mut">↑\${d.ahead} ↓\${d.behind}</span>\` : \` <span class="mut">(\${d.hasRemote ? "no upstream" : "no remote"})</span>\`}</td></tr>
      <tr><td class="k">last commit</td><td>\${esc(d.lastCommit)} <span class="mut">(\${esc(d.lastCommitAge)})</span></td></tr>
      \${d.dirtyTotal ? \`<tr><td class="k">dirty (\${d.dirtyTotal})</td><td><pre>\${esc(d.dirtyFiles.map((l) => (d.submodulesDirty ?? []).includes(dirtyPath(l)) ? l + "   ← submodule (commit inside it)" : l).join("\\n"))}\${d.dirtyTotal > 20 ? "\\n…" : ""}</pre></td></tr>\` : \`<tr><td class="k">worktree</td><td><span class="stat"><span class="sdot ok"></span>clean</span></td></tr>\`}
    </table>\` : '<span class="mut">not a git repository</span>';

  const agentMeta = [d.agent.age, d.agent.procs > 1 ? d.agent.procs + " sessions" : "", d.agent.source === "hook" ? "via hook" : ""].filter(Boolean).join(" · ");
  const agentHtml = d.agent.state === "working" ? \`<span class="stat" title="\${esc(d.agent.detail)}"><span class="sdot ok"></span>Working</span>\${agentMeta ? \` <span class="mut">· \${esc(agentMeta)}</span>\` : ""}\`
    : d.agent.state === "waiting" ? \`<span class="stat" style="color:var(--\${agentHot ? "bad" : "warn-ink"})" title="\${esc(d.agent.detail)}"><span class="sdot \${agentHot ? "bad" : "warn"}"></span>Waiting on you</span>\${agentMeta ? \` <span class="mut">· \${esc(agentMeta)}</span>\` : ""} <button class="runbtn" onclick="focusAgent()">↦ jump to it</button>\${d.agent.lastMessage ? \`<div class="lastmsg" title="\${esc(d.agent.lastMessage)}">“\${esc(d.agent.lastMessage)}”</div>\` : ""}\`
    : d.agent.state === "idle" ? \`<span class="stat mut" title="\${esc(d.agent.detail)}"><span class="sdot mut"></span>Idle</span>\`
    : '<span class="mut">none</span>';
  const wsBody = \`<table>
      <tr><td class="k">tmux</td><td>\${d.session ? \`<span class="stat"><span class="sdot ok"></span>running</span> <span class="mut">(\${d.windows.map(esc).join(", ")})</span>\` : \`<span class="mut">no session — <code>cockpit go \${esc(d.name)}</code></span>\`}</td></tr>
      <tr><td class="k">agent</td><td>\${agentHtml}</td></tr>
      \${(d.services || []).filter((s) => s.port).map((s) => \`<tr><td class="k">:\${s.port}</td><td>\${s.up ? '<span class="stat"><span class="sdot ok"></span>listening</span>' : '<span class="stat mut"><span class="sdot mut"></span>down</span>'} <span class="mut">\${esc(s.name || "")}</span></td></tr>\`).join("")}
      \${d.envFiles.length ? \`<tr><td class="k">env files</td><td class="mono">\${d.envFiles.map((f) => f.exists ? esc(f.path) : \`<span class="bad-t">\${esc(f.path)} missing</span>\`).join(", ")}</td></tr>\` : ""}
    </table>\`;

  const deployBody = d.lastPush
    ? \`<table><tr><td class="k">last push</td><td>\${esc(d.lastPush.age)} <span class="mut">(\${esc(d.lastPush.date.slice(0, 10))}, \${esc(d.lastPush.ref)})</span></td></tr></table>
       <div class="mut" style="margin-top:6px">Tip of \${esc(d.lastPush.ref)} as of the last fetch — for push-to-deploy projects this is the last PROD trigger.</div>\`
    : '<span class="mut">no remote branch found</span>';

  const commitsBody = d.commits.length
    ? d.commits.map((c) => \`<div class="commit"><span class="h mono">\${esc(c.hash)}</span><span class="s" title="\${esc(c.subject)}">\${esc(c.subject)}</span><span class="a">\${esc(c.age)}</span></div>\`).join("")
    : '<span class="mut">no commits</span>';

  const actionsBody = d.actions.length
    ? d.actions.map((a) => {
        const btn = a.tier === "manual"
          ? \`<button class="runbtn" onclick="copyCmd(\${JSON.stringify("cd " + d.root + " && " + a.cmd).replace(/"/g, "&quot;")}, this)">copy</button>\`
          : \`<button class="runbtn" id="act-\${esc(a.name)}" onclick="runAction('\${esc(a.name)}')">run</button>\`;
        return \`<div class="act"><span class="an">\${esc(a.name)}</span><code title="\${esc(a.cmd)}">\${esc(a.cmd)}</code>\${a.window ? \`<span class="win">tmux:\${esc(a.window)}</span>\` : ""}<span class="tier \${a.tier}">\${a.tier}</span>\${btn}</div>\`;
      }).join("") +
      \`<div id="runout">\${runOutHtml}</div>
      <div class="mut" style="margin-top:8px">safe runs · confirm asks first · <span class="bad-t">manual is never run from here</span> — copy and paste it yourself. Everything is audit-logged.</div>\`
    : '<span class="mut">no actions declared</span><div id="runout"></div>';

  let planBody = "", planHint = "";
  if (d.plan) {
    const s = d.planStats;
    planHint = \`\${d.plan.path} · \${s.ticketsDone}/\${s.ticketsTotal} tickets\${s.openQuestions ? \` · \${s.openQuestions} open question\${s.openQuestions > 1 ? "s" : ""}\` : ""}\`;
    const dirSorted = [...d.plan.direction].sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
    window._openQuestions = dirSorted.filter((q) => !q.done).map((q) => q.text);
    window._planTickets = [];
    let qi = -1;
    const dirHtml = dirSorted.length
      ? \`<div class="plansec">Direction</div>\` + dirSorted.map((q) => {
          if (q.done) return \`<div class="plq done"><span class="ck">✓</span><span class="qt" title="\${esc(q.text)}">\${esc(q.text)}</span></div>\`;
          qi++;
          return \`<div class="plq"><span class="oc"></span><span class="qt">\${esc(q.text)}</span>
              <span class="ansline"><button class="runbtn" onclick="openHints(\${qi})">hints…</button>
              <input id="ansin-\${qi}" placeholder="answer → decision + ticket"
                onkeydown="if(event.key==='Enter')submitAnswer(\${qi})">
              <button class="runbtn" id="ansbtn-\${qi}" onclick="submitAnswer(\${qi})">decide</button></span></div>\`;
        }).join("")
      : "";
    const featureDone = (f) => f.tickets.length > 0 && f.tickets.every((t) => t.done);
    const featSorted = [...d.plan.features].sort((a, b) => (featureDone(a) ? 1 : 0) - (featureDone(b) ? 1 : 0));
    const featHtml = featSorted.length
      ? \`<div class="plansec">Features</div>\` + featSorted.map((f) => {
          const done = f.tickets.filter((t) => t.done).length, total = f.tickets.length;
          const fd = featureDone(f);
          const tickets = [...f.tickets].sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0))
            .map((t) => {
              if (t.done) return \`<div class="trow done"><span class="ck">✓</span><span class="tt" title="\${esc(t.text)}">\${esc(t.text)}</span></div>\`;
              const wi = window._planTickets.push({ feature: f.name, text: t.text }) - 1;
              return \`<button class="trow" title="start implementing: \${esc(t.text)}" onclick="workTicket(\${wi})"><span class="oc"></span><span class="tt">\${esc(t.text)}</span></button>\`;
            }).join("");
          return \`<div class="feat \${fd ? "done" : ""}">
            <div class="fhead">\${fd ? \`<span class="ck">✓</span>\` : ""}\${esc(f.name)}
              <span class="fprog"><span class="fbar"><span style="width:\${total ? Math.round((done / total) * 100) : 0}%"></span></span> \${done}/\${total}</span></div>
            <div class="ftickets">\${tickets || '<span class="mut">no tickets yet</span>'}</div></div>\`;
        }).join("")
      : "";
    planBody = (dirHtml + featHtml) || '<span class="mut">plan.md found but empty — add ## Direction and ## Features sections</span>';
  } else {
    planBody = '<span class="mut">no plan.md — create one at the repo root: <code>## Direction</code> with checkbox questions, <code>## Features</code> with <code>### feature</code> blocks of checkbox tickets. Done items get a check, dim, and sink automatically.</span>';
  }

  const clBody = d.changelog
    ? \`<pre>\${esc(d.changelog.text)}</pre>\`
    : '<span class="mut">no changelog found (looked for CHANGELOG.md, docs/changelog.md — or set <code>changelog:</code> in .project-cockpit.yml)</span>';

  document.getElementById("main").innerHTML = \`
    <header>
      <div class="path mono">\${esc(d.root)}</div>
      <h2>\${d.icon ? esc(d.icon) + " " : ""}\${esc(d.name)}</h2>
      \${d.focus ? \`<p class="focus">\${esc(d.focus)}</p>\` : ""}
      \${d.provider?.limited ? \`<span class="quota" title="best-effort, read from recent Claude Code transcripts">⚠ Claude \${esc(d.provider.detail)} — dispatched agents may stall</span>\` : ""}
      <div class="links">\${links}</div>
    </header>
    \${attn}
    <div class="cards">
      \${card("plan", "Plan", planHint, planBody, true)}
    </div>
    <div class="cards small">
      \${card("git", "Git", d.branch, gitBody)}
      \${card("ws", "Workspace", d.session ? "tmux ✓" : "", wsBody)}
      \${card("deploy", "Deploy", d.lastPush ? d.lastPush.age : "", deployBody)}
      \${card("commits", "Recent commits", "", commitsBody)}
    </div>
    <div class="cards">
      \${card("changelog", "Changelog", d.changelog ? d.changelog.path : "", clBody, true)}
      \${card("actions", "Actions", "", actionsBody, true)}
    </div>
    <footer><span id="freshness">updated just now</span> · <button class="runbtn" style="font-size:11px;padding:1px 9px" onclick="refresh()">↻ refresh now</button> · state recomputed live from git/tmux/lsof · <kbd>⌘K</kbd> palette</footer>\`;
  if (auditShown) { auditShown = false; toggleAudit(); }
}

// ---------- command palette ----------
let palHot = 0;
function paletteItems(q) {
  const items = [];
  for (const p of projectsCache) items.push({ label: p.name, k2: "switch to project", fn: () => pick(p.name) });
  if (detailCache) {
    if (detailCache.agent?.state === "waiting")
      items.push({ label: "jump to waiting agent", k2: detailCache.name, fn: () => focusAgent() });
    for (const t of ["cursor", "finder", "obsidian", "github", "deploy", "dev"])
      items.push({ label: \`open \${t}\`, k2: detailCache.name, fn: () => openIn(t) });
    for (const a of detailCache.actions ?? [])
      items.push({ label: \`run \${a.name}\`, k2: \`\${detailCache.name} · \${a.tier}\`, fn: a.tier === "manual" ? () => alert("manual tier — copy it from the Actions card") : () => runAction(a.name) });
  }
  const needle = q.trim().toLowerCase();
  return needle ? items.filter((i) => (i.label + " " + i.k2).toLowerCase().includes(needle)) : items;
}
function renderPalette() {
  const q = document.getElementById("palq").value;
  const items = paletteItems(q).slice(0, 12);
  palHot = Math.min(palHot, Math.max(0, items.length - 1));
  document.getElementById("palitems").innerHTML = items.map((i, idx) =>
    \`<div class="item \${idx === palHot ? "hot" : ""}" data-i="\${idx}"><span>\${esc(i.label)}</span><span class="k2">\${esc(i.k2)}</span></div>\`).join("");
  document.querySelectorAll("#palitems .item").forEach((el) => {
    el.onclick = () => { const i = paletteItems(q).slice(0, 12)[Number(el.dataset.i)]; closePalette(); i.fn(); };
  });
}
function openPalette() { document.getElementById("palette").classList.add("open"); const inp = document.getElementById("palq"); inp.value = ""; palHot = 0; renderPalette(); inp.focus(); }
function closePalette() { document.getElementById("palette").classList.remove("open"); }
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  const pal = document.getElementById("palette");
  if (!pal.classList.contains("open")) return;
  const items = paletteItems(document.getElementById("palq").value).slice(0, 12);
  if (e.key === "Escape") closePalette();
  else if (e.key === "ArrowDown") { palHot = Math.min(palHot + 1, items.length - 1); renderPalette(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { palHot = Math.max(palHot - 1, 0); renderPalette(); e.preventDefault(); }
  else if (e.key === "Enter" && items[palHot]) { closePalette(); items[palHot].fn(); }
});
document.getElementById("palq").addEventListener("input", () => { palHot = 0; renderPalette(); });

// ---------- plan: answer a direction question ----------
async function submitAnswer(i) {
  const input = document.getElementById("ansin-" + i);
  const btn = document.getElementById("ansbtn-" + i);
  const answer = (input?.value ?? "").trim();
  if (!answer) { input?.focus(); return; }
  const question = (window._openQuestions ?? [])[i];
  if (btn) { btn.disabled = true; btn.textContent = "saving…"; }
  const r = await fetch("/api/plan/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected, question, answer }) });
  const dd = await r.json();
  if (!r.ok) { alert(dd.error || "failed"); if (btn) { btn.disabled = false; btn.textContent = "decide"; } return; }
  if (input) input.value = ""; // clear so the don't-clobber-typing guard lets refresh re-render
  if (confirm((detailCache?.provider?.limited ? "⚠ Claude looks rate-limited right now (" + detailCache.provider.detail + ") — an implementation session may stall until it resets.\\n\\n" : "") + "Saved to plan.md: question checked with your answer, and a ticket added to '### Implementation queue'. Nothing is running yet.\\n\\nStart implementation NOW?\\n\\nOK — opens a live Claude Code session in " + selected + "'s tmux workspace (new 'impl' window), briefed with this decision. It starts working immediately; watch or steer it with: cockpit go " + selected + "\\n\\nCancel — leave it as a queued ticket. Start it later yourself: cockpit go " + selected + ", then in the agent tab ask Claude to work the Implementation queue in plan.md.")) {
    const ir = await fetch("/api/plan/implement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected, question, answer }) });
    const id = await ir.json();
    if (!ir.ok) alert(id.error || "failed to start implementation");
    else alert("Implementation running in tmux window \\"impl\\" — watch it with: cockpit go " + selected + "\\nThe agent indicator on this dashboard will show it as Working.");
  }
  refresh();
}

// ---------- attention chips: explain / fix ----------
function fixCmdHtml(cmd) {
  return \`<div class="fixcmd"><code>\${esc(cmd)}</code><button class="runbtn" onclick="copyCmd(\${JSON.stringify(cmd).replace(/"/g, "&quot;")}, this)">copy</button></div>\`;
}
function openFix(i) {
  const item = detailCache?.attention?.[i];
  if (!item) return;
  const d = detailCache;
  const title = document.getElementById("fixtitle");
  const body = document.getElementById("fixbody");
  title.textContent = "▲ " + item;
  let html = "";
  if (/^agent waiting/.test(item)) {
    html = \`<p>A Claude Code session in this project \${esc(d.agent.detail || "needs your reply")}\${d.agent.age ? " (" + esc(d.agent.age) + ")" : ""}. This one is genuinely yours: it needs your reply, so there is nothing safe to automate.</p>
      \${d.agent.lastMessage ? \`<p><strong>It last said:</strong></p><pre>\${esc(d.agent.lastMessage)}</pre>\` : ""}
      <p><button class="runbtn" onclick="focusAgent()">↦ jump to its terminal</button>
      <span class="mut">— selects the exact tmux window and raises iTerm2. Focus only, nothing runs.</span></p>
      <div id="fixout"></div>
      <p><strong>Or go yourself:</strong></p>\${fixCmdHtml("cockpit go " + d.name)}
      <p class="mut">Then check the <b>agent</b> (or <b>impl</b>/<b>commit</b>) tab. Resume a closed conversation with <code>claude --continue</code>.</p>\`;
  } else if (/uncommitted$/.test(item)) {
    const subs = d.submodulesDirty ?? [];
    const plain = (d.dirtyFiles ?? []).filter((l) => !subs.includes(dirtyPath(l)));
    const subNote = subs.length
      ? \`<p><strong>⚠ \${subs.length === 1 ? "This is a submodule" : "Submodules"}:</strong> <code>\${subs.map(esc).join("</code>, <code>")}</code> — its changes live in its <em>own</em> repo. A commit here cannot include them: commit <em>inside</em> the submodule first, then commit the updated pointer here.</p>\${fixCmdHtml("cd " + d.root + "/" + subs[0])}\`
      : "";
    html = \`<p>What's uncommitted right now (\${d.dirtyTotal}):</p>
      <pre>\${esc((d.dirtyFiles ?? []).join("\\n"))}\${d.dirtyTotal > (d.dirtyFiles ?? []).length ? "\\n…" : ""}</pre>
      \${subNote}
      \${plain.length ? \`<p><button class="runbtn" onclick="fixCommitAgent()">🤖 have Claude review &amp; commit</button>
      <span class="mut">— attended session in a tmux <b>commit</b> window; groups changes into sensible commits. It will not push.</span></p>
      <p><strong>Or do it yourself:</strong></p>\${fixCmdHtml("cd " + d.root)}\${fixCmdHtml("git add -A && git commit")}\` : ""}
      <div id="fixout"></div>\`;
  } else if (/unpushed$/.test(item)) {
    html = \`<p>Local commits GitHub doesn't have. Pushing is <b>manual by design</b> in your safety model (and for some projects push = deploy) — the cockpit won't do it for you.</p>
      \${fixCmdHtml("git -C " + d.root + " push")}\`;
  } else if (/behind remote$/.test(item)) {
    html = \`<p>The remote has commits your local copy doesn't. A fast-forward pull is safe: it only applies when your local branch has no divergent commits — otherwise it refuses and changes nothing.</p>
      <p><button class="runbtn" onclick="fixPull()">⬇ pull --ff-only now</button></p><div id="fixout"></div>
      <p class="mut">If it refuses (diverged history), that needs a human decision — merge or rebase in the project's shell tab.</p>\`;
  } else if (/^no upstream/.test(item)) {
    html = \`<p>The current branch isn't linked to a remote branch, so ahead/behind can't be tracked. Linking it does a push, which stays manual:</p>
      \${fixCmdHtml("git -C " + d.root + " push -u origin " + (d.branch || "main"))}\`;
  } else if (/open questions?$/.test(item)) {
    html = \`<p>Unanswered Direction questions are the decisions quietly keeping this project in limbo. Each has <b>hints…</b> (context + generated options) and an answer field.</p>
      <p><button class="runbtn" onclick="closeFix(); const el = document.getElementById('plan'); el.open = true; el.scrollIntoView({behavior:'smooth'})">take me to the questions</button></p>\`;
  } else if (/^foundation v/.test(item)) {
    const f = d.foundation || {};
    const scripts = (f.sourceRoot || "") + "/scripts";
    html = \`<p>This project was onboarded with foundation <b>v\${esc(f.installed || "?")}</b> (\${esc(f.date || "")}); the foundation repo now ships <b>v\${esc(f.current || "?")}</b>. Newer versions add assets (rules, skills, agents, settings) this project doesn't have yet.</p>
      <p><strong>See exactly what's missing</strong> (read-only):</p>\${fixCmdHtml(scripts + "/audit-project.sh " + d.root)}
      <p><strong>Then refresh:</strong> re-running onboard is additive — it installs missing assets and never touches files that already exist:</p>\${fixCmdHtml(scripts + "/onboard-project.sh " + d.root)}
      <p class="mut">Replacing <em>managed blocks</em> in existing files needs the upgrade script (ticketed as issue #8 in the foundation repo) — until then, changed managed content is a manual diff.</p>\`;
  } else if (/no \\.project-cockpit\\.yml/.test(item)) {
    html = \`<p>Without a config the cockpit only sees git and tmux — no services, ports, actions, or focus line.</p>
      <p><button class="runbtn" onclick="fixConfig()">＋ create .project-cockpit.yml from template</button></p><div id="fixout"></div>
      <p class="mut">Then edit it (Cursor button above) to add your dev command, ports, and links.</p>\`;
  } else {
    html = \`<p class="mut">No playbook for this one yet.</p>\`;
  }
  body.innerHTML = html;
  document.getElementById("fixmodal").classList.add("open");
}
function closeFix() { document.getElementById("fixmodal").classList.remove("open"); }
function setFixOut(headline, text) {
  const el = document.getElementById("fixout");
  if (el) el.innerHTML = \`<p><strong>\${esc(headline)}</strong></p>\${text ? \`<pre>\${esc(text)}</pre>\` : ""}\`;
}
async function fixPull() {
  if (!confirm("Run git pull --ff-only in " + selected + "?")) return;
  setFixOut("pulling…", "");
  const r = await fetch("/api/fix/pull", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected }) });
  const d = await r.json();
  setFixOut(d.ok ? "✓ pulled" : "✗ exit " + d.status, d.output || d.error || "");
  refresh();
}
async function fixConfig() {
  const r = await fetch("/api/fix/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected }) });
  const d = await r.json();
  if (!r.ok) { setFixOut("✗ " + (d.error || "failed"), ""); return; }
  closeFix();
  refresh();
}
async function focusAgent(win) {
  const r = await fetch("/api/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected, window: win }) });
  const d = await r.json();
  if (!r.ok) { (document.getElementById("fixout") ? setFixOut("✗ " + (d.error || "failed"), "") : alert(d.error || "failed")); return; }
  if (!d.attached) {
    const msg = 'tmux window "' + d.window + '" selected — no terminal attached. Attach with: cockpit go ' + selected;
    document.getElementById("fixout") ? setFixOut(msg, "") : alert(msg);
  } else if (document.getElementById("fixout")) {
    setFixOut('✓ focused tmux window "' + d.window + '" — check iTerm2', "");
  }
}
async function fixCommitAgent() {
  if (!confirm("Open a Claude Code session in " + selected + "'s tmux (new 'commit' window) to review and commit the changes? It will not push.")) return;
  const r = await fetch("/api/fix/commit-agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected }) });
  const d = await r.json();
  if (!r.ok) { setFixOut("✗ " + (d.error || "failed"), ""); return; }
  setFixOut("✓ session started in tmux window \\"commit\\"", "Watch it with: cockpit go " + selected + "\\nIt may ask for permission approvals there.");
}

// ---------- plan: work a ticket ----------
async function workTicket(i) {
  const t = (window._planTickets ?? [])[i];
  if (!t) return;
  const quotaWarn = detailCache?.provider?.limited ? "⚠ Claude looks rate-limited right now (" + detailCache.provider.detail + ") — the session may stall until it resets.\\n\\n" : "";
  if (!confirm(quotaWarn + "Start implementing this ticket?\\n\\n  " + t.text + "\\n  (feature: " + t.feature + ")\\n\\nOpens an attended Claude Code session in " + selected + "'s tmux 'impl' window, briefed with this ticket. It will check the box in plan.md when done. It will not push.")) return;
  const r = await fetch("/api/plan/work", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected, feature: t.feature, ticket: t.text }) });
  const d = await r.json();
  if (!r.ok) { alert(d.error || "failed"); return; }
  alert("Working on it — tmux window \\"impl\\" in " + selected + ". The agent indicator will show Working while it runs; watch with: cockpit go " + selected);
  refresh();
}

// ---------- plan: hints & generated options ----------
// options + selections are cached per question, so reopening never regenerates
window._optCache = {};
async function openHints(i) {
  const question = (window._openQuestions ?? [])[i];
  window._hintQ = i;
  document.getElementById("hintmodal").classList.add("open");
  const body = document.getElementById("hintbody");
  document.getElementById("hinttitle").textContent = question;
  body.innerHTML = '<div class="mut" style="padding:12px 16px">loading context…</div>';
  const r = await fetch("/api/plan/hints?project=" + encodeURIComponent(selected) + "&question=" + encodeURIComponent(question));
  const d = await r.json();
  const refs = (d.refs ?? []).map((ref) =>
    \`<details open style="margin:0 16px 10px"><summary style="padding:6px 0">\${esc(ref.path)}</summary><pre>\${esc(ref.excerpt)}</pre></details>\`).join("");
  body.innerHTML =
    (refs || '<div class="mut" style="padding:8px 16px">no referenced planning docs found in the question text</div>') +
    \`<div style="padding:8px 16px 14px"><button class="runbtn" id="genbtn" onclick="genOptions()">✨ generate options with Claude</button>
     <span class="mut" style="font-size:12px"> — reads the docs above + plan.md, ~15-60s</span><div id="optlist"></div></div>\`;
  if (window._optCache[question]) renderOptions();
  updateUseBtn();
}
function closeHints() { document.getElementById("hintmodal").classList.remove("open"); }
function cacheEntry() {
  const question = (window._openQuestions ?? [])[window._hintQ];
  return window._optCache[question];
}
async function genOptions() {
  const btn = document.getElementById("genbtn");
  btn.disabled = true; btn.textContent = "thinking…";
  const question = (window._openQuestions ?? [])[window._hintQ];
  const r = await fetch("/api/plan/options", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected, question }) });
  const d = await r.json();
  btn.disabled = false; btn.textContent = "✨ generate options with Claude";
  const list = document.getElementById("optlist");
  if (!r.ok) { list.innerHTML = \`<div class="bad-t" style="padding:8px 0">\${esc(d.error || "failed")}</div>\`; return; }
  if (d.options) {
    window._optCache[question] = { options: d.options, sel: new Set() };
    renderOptions();
  } else {
    list.innerHTML = \`<pre>\${esc(d.raw || "")}</pre>\`;
  }
}
function renderOptions() {
  const entry = cacheEntry();
  const list = document.getElementById("optlist");
  if (!entry || !list) return;
  list.innerHTML = '<div class="mut" style="padding:10px 0 4px;font-size:12px">click to select one or more — selections combine into the answer field:</div>' +
    entry.options.map((o, oi) => \`<div class="optitem \${entry.sel.has(oi) ? "sel" : ""}" data-oi="\${oi}">
      <span class="tick">✓</span><strong>\${esc(o.label)}</strong>\${o.detail ? \`<br><span class="mut">\${esc(o.detail)}</span>\` : ""}</div>\`).join("");
  list.querySelectorAll(".optitem").forEach((el) => {
    el.onclick = () => {
      const oi = Number(el.dataset.oi);
      entry.sel.has(oi) ? entry.sel.delete(oi) : entry.sel.add(oi);
      renderOptions();
    };
  });
  updateUseBtn();
}
function updateUseBtn() {
  const btn = document.getElementById("usebtn");
  const entry = cacheEntry();
  const n = entry ? entry.sel.size : 0;
  btn.disabled = n === 0;
  btn.textContent = n ? \`use \${n} selected → answer field\` : "use selected → answer field";
}
function useSelected() {
  const entry = cacheEntry();
  if (!entry || !entry.sel.size) return;
  const text = [...entry.sel].sort().map((oi) => entry.options[oi].label).join("; ");
  const input = document.getElementById("ansin-" + window._hintQ);
  if (input) { input.value = text; }
  closeHints();
  input?.focus();
}

// ---------- add project ----------
async function openAdd() {
  document.getElementById("addmodal").classList.add("open");
  const inp = document.getElementById("addpath");
  inp.value = ""; inp.focus();
  const cands = await (await fetch("/api/candidates")).json();
  document.getElementById("addcands").innerHTML =
    (cands.length ? '<div class="hdr">Found near your projects — click to add:</div>' : "") +
    cands.map((c) => \`<div class="item" onclick="submitAdd('\${esc(c.path)}')"><span>\${esc(c.name)}</span><span class="k2">\${c.hasConfig ? "has config · " : ""}\${esc(c.path)}</span></div>\`).join("");
}
function closeAdd() { document.getElementById("addmodal").classList.remove("open"); }
async function submitAdd(path) {
  if (!path.trim()) return;
  const r = await fetch("/api/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  const d = await r.json();
  if (!r.ok) { alert(d.error || "failed"); return; }
  closeAdd();
  selected = d.name;
  location.hash = encodeURIComponent(selected);
  openState = {};
  await refresh();
  if (d.onboardHint) {
    const title = document.getElementById("fixtitle");
    const body = document.getElementById("fixbody");
    title.textContent = "＋ " + d.name + " added — onboard it?";
    body.innerHTML = \`<p>This repo doesn't have the foundation yet (no <code>.ai/foundation-version.md</code>). Onboarding installs rules, skills, the permission profile, and subagents — additively, never overwriting existing files:</p>
      \${fixCmdHtml(d.onboardHint)}
      <p class="mut">Optional — the cockpit works either way. Close this if the project shouldn't carry the foundation.</p>\`;
    document.getElementById("fixmodal").classList.add("open");
  }
}

let lastRefreshAt = Date.now();
const _origRefresh = refresh;
refresh = async function () { await _origRefresh(); lastRefreshAt = Date.now(); };
setInterval(() => {
  const el = document.getElementById("freshness");
  if (!el) return;
  const s = Math.round((Date.now() - lastRefreshAt) / 1000);
  el.textContent = s <= 2 ? "updated just now" : \`updated \${s}s ago\`;
  if (s > 25) el.style.color = "var(--warn-ink)"; else el.style.color = "";
}, 1000);

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

// /focus — attention-only compact view: nearly nothing when all is quiet,
// one row per project that needs you. Sized for an always-on-top sliver of a
// browser window or a phone home-screen bookmark over Tailscale.
const FOCUS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cockpit · focus</title>
<style>
  :root {
    --bg: #f4f3f0; --surface: #fff; --line: rgba(26,32,41,.09);
    --ink: #1a2029; --ink-2: #5b6572; --ink-3: #8a93a0; --accent: #2563eb;
    --ok: #177a3b; --warn-ink: #8a5a00; --warn-bg: #f9efd8; --bad: #b42318; --bad-bg: #fdecea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12161b; --surface: #1c222a; --line: rgba(232,236,241,.09);
      --ink: #e8ecf1; --ink-2: #a6b0bc; --ink-3: #6f7a87; --accent: #6ea8fe;
      --ok: #4ade80; --warn-ink: #f2c94c; --warn-bg: rgba(242,201,76,.13); --bad: #f87171; --bad-bg: rgba(248,113,113,.13);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; background: var(--bg); color: var(--ink); padding: 10px; }
  .row { display: flex; align-items: center; gap: 9px; background: var(--surface); border-radius: 10px; padding: 9px 12px; margin-bottom: 8px; min-width: 0; }
  .pdot { width: 6px; height: 6px; border-radius: 2px; flex: none; }
  .nm { font-weight: 600; flex: none; }
  .why { flex: 1; min-width: 0; color: var(--warn-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .why.hot { color: var(--bad); }
  .jump { font: 12px inherit; border: 1px solid var(--line); background: none; color: var(--accent); border-radius: 7px; padding: 2px 10px; cursor: pointer; flex: none; }
  .quiet { color: var(--ink-3); text-align: center; padding: 30px 10px; }
  .quiet .big { font-size: 26px; }
  footer { color: var(--ink-3); font-size: 11px; text-align: center; margin-top: 6px; }
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div id="list"><div class="quiet">loading…</div></div>
<footer><a href="/">full dashboard</a> · <span id="fresh"></span></footer>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
async function jump(name) {
  const r = await fetch("/api/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: name }) });
  const d = await r.json();
  if (!r.ok) alert(d.error || "failed");
  else if (!d.attached) alert('tmux window "' + d.window + '" selected — attach with: cockpit go ' + name);
}
async function refresh() {
  const projects = await (await fetch("/api/projects")).json();
  const need = projects.filter((p) => p.attention.length);
  document.getElementById("list").innerHTML = need.length
    ? need.map((p) => {
        const hot = p.agent.state === "waiting" && (p.agent.ageSec ?? 0) >= 600;
        const why = p.attention.join(" · ");
        return \`<div class="row"><span class="pdot" style="background:\${esc(p.color)}"></span><span class="nm">\${p.icon ? esc(p.icon) + " " : ""}\${esc(p.name)}</span><span class="why \${hot ? "hot" : ""}" title="\${esc(why)}">\${esc(why)}</span>\${p.agent.state === "waiting" ? \`<button class="jump" onclick="jump('\${esc(p.name)}')">↦ jump</button>\` : ""}</div>\`;
      }).join("")
    : '<div class="quiet"><div class="big">✓</div>all quiet — nothing needs you</div>';
  document.getElementById("fresh").textContent = "updated " + new Date().toLocaleTimeString();
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flagVal = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number(argv.find((a) => /^\d+$/.test(a))) || 4400;
  startServer(port, { host: flagVal("--host"), token: flagVal("--token") });
}
