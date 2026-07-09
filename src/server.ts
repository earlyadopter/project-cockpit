// cockpit dashboard — Phase 2 (read-only views) + Phase 3 (actions, palette, audit).
// One process, no daemon state: every request recomputes live state via state.ts.
// Tier enforcement lives HERE, server-side: safe runs, confirm needs an explicit
// confirmed flag (set by the UI dialog), manual is always refused with the command
// to copy. Binds 127.0.0.1 only; non-GET requests must be same-origin.
// Start with `cockpit dash` or `bun src/server.ts`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { statSync } from "node:fs";
import {
  type Project,
  agentState, allProjects, answerDirection, attentionItems, audit, claudeCwds, cleanForPrompt,
  createConfigFromTemplate, discoverCandidates, findPlanningRefs, generateOptions,
  foundationSource, gitState, humanAge, lastPush, loadProject, loadRegistry, localService, openTarget,
  readFoundation,
  planStats, portListening, readAudit, readChangelog, readPlan, recentCommits,
  runInline, saveRegistry, sendToWindow, shA, startAgentTask, startImplementation,
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
  return {
    name: p.name, root: p.root, focus: p.cfg.focus ?? "", branch: git.branch,
    dirty: git.dirty.length, ahead: git.ahead, behind: git.behind,
    session, devPort: svc?.port ?? null, devUp,
    agent: { ...agent, age: humanAge(agent.ageSec) },
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
    windows, lastPush: push, commits, services,
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

export function startServer(port = 4400) {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

      // Same-origin guard for anything that mutates.
      if (req.method !== "GET") {
        const origin = req.headers.get("origin");
        if (origin && new URL(origin).host !== url.host) return json({ error: "cross-origin request refused" }, 403);
      }

      if (req.method === "GET" && url.pathname === "/api/projects") {
        const cwds = await claudeCwds();
        const projects = await Promise.all(allProjects().map((p) => projectSummary(p, cwds)));
        projects.sort((a, b) => (b.attention.length ? 1 : 0) - (a.attention.length ? 1 : 0) || a.name.localeCompare(b.name));
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
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`cockpit dashboard: http://localhost:${server.port} (Ctrl-C to stop)`);
  return server;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cockpit</title>
<style>
  :root {
    --bg: #f6f7f9; --surface: #ffffff; --border: #e3e6ea;
    --ink: #1a2029; --ink-2: #5b6572; --ink-3: #8a93a0;
    --accent: #2563eb; --ok: #1a7f37; --warn-bg: #fff3cd; --warn-ink: #7a5d00; --warn-border: #e6d28a;
    --bad: #b42318; --chip-bg: #eef1f4; --overlay: rgba(20,24,29,.45);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14181d; --surface: #1c2128; --border: #303842;
      --ink: #e8ecf1; --ink-2: #a6b0bc; --ink-3: #6f7a87;
      --accent: #6ea8fe; --ok: #4ade80; --warn-bg: #3a2e14; --warn-ink: #ffd561; --warn-border: #6b5a1e;
      --bad: #f87171; --chip-bg: #262d36; --overlay: rgba(0,0,0,.55);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
  .layout { display: flex; min-height: 100vh; }
  aside { width: 250px; flex: none; border-right: 1px solid var(--border); background: var(--surface); padding: 12px 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; }
  aside h1 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); margin: 4px 16px 10px; }
  aside .grow { flex: 1; }
  aside .foot { padding: 10px 16px; font-size: 12px; color: var(--ink-3); border-top: 1px solid var(--border); }
  aside .foot button { background: none; border: 0; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }
  .proj { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--ink); padding: 9px 16px; cursor: pointer; font: inherit; border-left: 3px solid transparent; }
  .proj:hover { background: var(--chip-bg); }
  .proj.sel { border-left-color: var(--accent); background: var(--chip-bg); }
  .proj .nm { font-weight: 600; display: flex; align-items: center; gap: 7px; }
  .proj .sub { color: var(--ink-2); font-size: 12px; margin-left: 17px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn-ink); }
  main { flex: 1; padding: 22px 26px; min-width: 0; }
  header .path { color: var(--ink-3); font-size: 12px; }
  header h2 { margin: 2px 0 2px; font-size: 22px; }
  .focus { color: var(--ink-2); font-style: italic; margin: 0 0 10px; }
  .links { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 4px; }
  .links a, .links button { text-decoration: none; color: var(--accent); background: var(--chip-bg); border: 1px solid var(--border); padding: 4px 11px; border-radius: 999px; font-size: 13px; cursor: pointer; font-family: inherit; }
  .links a:hover, .links button:hover { border-color: var(--accent); }
  .attn { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
  .attnbtn { background: var(--warn-bg); color: var(--warn-ink); border: 1px solid var(--warn-border); padding: 3px 10px; border-radius: 6px; font-size: 13px; font-weight: 500; font-family: inherit; cursor: pointer; }
  .attnbtn:hover { border-color: var(--warn-ink); }
  .attnbtn .chev { margin-left: 6px; opacity: .6; }
  .fixcmd { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .fixcmd code { background: var(--chip-bg); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; flex: 1; overflow-x: auto; white-space: nowrap; }
  .calm { color: var(--ok); font-size: 13px; margin: 14px 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; margin-top: 10px; }
  .cards.small { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .cards.small details { font-size: 12.5px; }
  .cards.small summary { padding: 8px 12px; font-size: 13px; }
  .cards.small .body { padding: 0 12px 10px; }
  .cards.small pre { max-height: 170px; font-size: 11px; }
  .cards.small .commit { font-size: 12px; }
  .tkbtn { cursor: pointer; font-family: inherit; text-align: left; }
  .tkbtn:hover { border-color: var(--accent); color: var(--accent); }
  details.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 0; overflow: hidden; }
  details.wide { grid-column: 1 / -1; }
  summary { cursor: pointer; padding: 11px 14px; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 8px; user-select: none; }
  summary::before { content: "▸"; color: var(--ink-3); font-size: 11px; transition: transform .12s; }
  details[open] summary::before { transform: rotate(90deg); }
  summary .hint { font-weight: 400; color: var(--ink-3); font-size: 12px; margin-left: auto; }
  .body { padding: 2px 14px 13px; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 3px 10px 3px 0; vertical-align: top; }
  td.k { color: var(--ink-2); white-space: nowrap; width: 1%; }
  .mono, pre, code { font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
  pre { background: var(--chip-bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; max-height: 340px; overflow-y: auto; }
  .ok-t { color: var(--ok); } .bad-t { color: var(--bad); } .mut { color: var(--ink-3); }
  .tier { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); }
  .tier.safe { color: var(--ok); } .tier.confirm { color: var(--warn-ink); background: var(--warn-bg); border-color: var(--warn-border); } .tier.manual { color: var(--bad); }
  .commit { display: flex; gap: 10px; padding: 2px 0; }
  .commit .h { color: var(--ink-3); flex: none; } .commit .a { color: var(--ink-3); margin-left: auto; flex: none; }
  footer { color: var(--ink-3); font-size: 12px; margin-top: 18px; }
  .empty { color: var(--ink-3); padding: 40px; text-align: center; }
  .runbtn { font: 12px inherit; padding: 2px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--chip-bg); color: var(--ink); cursor: pointer; }
  .runbtn:hover { border-color: var(--accent); color: var(--accent); }
  .runbtn:disabled { opacity: .5; cursor: wait; }
  kbd { font: 11px ui-monospace, Menlo, monospace; background: var(--chip-bg); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; }
  #palette, #addmodal, #hintmodal, #fixmodal { position: fixed; inset: 0; background: var(--overlay); display: none; z-index: 10; }
  #palette.open, #addmodal.open, #hintmodal.open, #fixmodal.open { display: block; }
  #fixmodal .box { margin: 12vh auto 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 18px 50px rgba(0,0,0,.3); max-height: 76vh; display: flex; flex-direction: column; }
  #palette .box, #addmodal .box { width: min(560px, 90vw); margin: 12vh auto 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 18px 50px rgba(0,0,0,.3); }
  #hintmodal .box { width: min(1100px, 94vw); margin: 5vh auto 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 18px 50px rgba(0,0,0,.3); display: flex; flex-direction: column; max-height: 88vh; }
  #hintmodal .items { max-height: none; overflow-y: auto; flex: 1; }
  #hintmodal pre { margin: 4px 0 8px; max-height: 48vh; }
  .optitem { border-top: 1px solid var(--border); padding: 10px 12px; border-radius: 8px; cursor: pointer; position: relative; }
  .optitem .tick { position: absolute; right: 12px; top: 10px; color: var(--accent); font-weight: 700; visibility: hidden; }
  .optitem.sel { background: var(--chip-bg); outline: 2px solid var(--accent); outline-offset: -2px; }
  .optitem.sel .tick { visibility: visible; }
  #hintfoot { border-top: 1px solid var(--border); padding: 10px 16px; display: flex; align-items: center; gap: 12px; flex: none; }
  #hintfoot .expl { color: var(--ink-3); font-size: 12px; line-height: 1.4; }
  #palette input, #addmodal input { width: 100%; border: 0; outline: 0; background: none; color: var(--ink); font: 16px inherit; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  #palette .items, #addmodal .items { max-height: 46vh; overflow-y: auto; }
  #palette .item, #addmodal .item { padding: 9px 16px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
  #palette .item.hot, #palette .item:hover, #addmodal .item:hover { background: var(--chip-bg); }
  #palette .item .k2, #addmodal .item .k2 { color: var(--ink-3); font-size: 12px; margin-left: auto; flex: none; }
  #addmodal .hdr { padding: 8px 16px 4px; color: var(--ink-3); font-size: 12px; }
  .plansec { font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-3); margin: 10px 0 4px; }
  .plq { padding: 3px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .plq.done { color: var(--ink-3); display: block; }
  .ansline { display: inline-flex; gap: 6px; align-items: center; margin-left: auto; }
  .ansline input { width: 300px; max-width: 40vw; font: 12.5px inherit; color: var(--ink); background: var(--chip-bg); border: 1px solid var(--border); border-radius: 6px; padding: 3px 9px; outline: none; }
  .ansline input:focus { border-color: var(--accent); }
  .feat { padding: 6px 0; border-top: 1px solid var(--border); }
  .feat:first-of-type { border-top: 0; }
  .feat.done .fhead { color: var(--ink-3); }
  .fhead { font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .fprog { margin-left: auto; display: flex; align-items: center; gap: 7px; font-weight: 400; font-size: 12px; color: var(--ink-3); }
  .fbar { width: 90px; height: 6px; border-radius: 3px; background: var(--chip-bg); border: 1px solid var(--border); overflow: hidden; display: inline-block; }
  .fbar > span { display: block; height: 100%; background: var(--accent); }
  .ftickets { margin-top: 3px; display: flex; flex-wrap: wrap; gap: 6px; }
  .tk { background: var(--chip-bg); border: 1px solid var(--border); border-radius: 6px; padding: 2px 9px; font-size: 12.5px; }
  .tk.done { color: var(--ink-3); }
</style>
</head>
<body>
<div class="layout">
  <aside>
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

async function refresh() {
  projectsCache = await (await fetch("/api/projects")).json();
  if (!selected && projectsCache.length) selected = projectsCache[0].name;
  document.getElementById("side").innerHTML = projectsCache.map((p) => \`
    <button class="proj \${p.name === selected ? "sel" : ""}" onclick="pick('\${esc(p.name)}')">
      <div class="nm"><span class="dot \${p.attention.length ? "warn" : "ok"}"></span>\${esc(p.name)}</div>
      <div class="sub">\${esc(p.branch || "—")}\${p.session ? " · tmux" : ""}\${p.devUp ? " · :" + p.devPort : ""}\${p.agent.state === "working" ? " · agent ✳" : p.agent.state === "waiting" ? " · agent ✋" : ""}\${p.attention.length ? " · ▲ " + p.attention.length : ""}</div>
    </button>\`).join("");
  if (selected) renderDetail();
}

function pick(name) { selected = name; location.hash = encodeURIComponent(name); openState = {}; refresh(); }

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

  const attn = d.attention.length
    ? \`<div class="attn">\${d.attention.map((a, ai) => \`<button class="attnbtn" onclick="openFix(\${ai})">▲ \${esc(a)}<span class="chev">›</span></button>\`).join("")}</div>\`
    : \`<div class="calm">✓ nothing needs attention</div>\`;

  const gitBody = d.branch ? \`<table>
      <tr><td class="k">branch</td><td class="mono">\${esc(d.branch)}\${d.hasUpstream ? \` <span class="mut">↑\${d.ahead} ↓\${d.behind}</span>\` : \` <span class="mut">(\${d.hasRemote ? "no upstream" : "no remote"})</span>\`}</td></tr>
      <tr><td class="k">last commit</td><td>\${esc(d.lastCommit)} <span class="mut">(\${esc(d.lastCommitAge)})</span></td></tr>
      \${d.dirtyTotal ? \`<tr><td class="k">dirty (\${d.dirtyTotal})</td><td><pre>\${esc(d.dirtyFiles.map((l) => (d.submodulesDirty ?? []).includes(dirtyPath(l)) ? l + "   ← submodule (commit inside it)" : l).join("\\n"))}\${d.dirtyTotal > 20 ? "\\n…" : ""}</pre></td></tr>\` : \`<tr><td class="k">worktree</td><td class="ok-t">clean ✓</td></tr>\`}
    </table>\` : '<span class="mut">not a git repository</span>';

  const agentHtml = d.agent.state === "working" ? \`<span class="ok-t">working ✳</span> <span class="mut">— \${esc(d.agent.detail)}, \${esc(d.agent.age)}</span>\`
    : d.agent.state === "waiting" ? \`<span style="color:var(--warn-ink)">waiting for you ✋</span> <span class="mut">— \${esc(d.agent.detail)}, \${esc(d.agent.age)}</span>\`
    : d.agent.state === "idle" ? \`<span class="mut">idle — \${esc(d.agent.detail)}</span>\`
    : '<span class="mut">none</span>';
  const wsBody = \`<table>
      <tr><td class="k">tmux</td><td>\${d.session ? \`<span class="ok-t">session running ✓</span> <span class="mut">(\${d.windows.map(esc).join(", ")})</span>\` : \`<span class="mut">no session — <code>cockpit go \${esc(d.name)}</code></span>\`}</td></tr>
      <tr><td class="k">agent</td><td>\${agentHtml}\${d.agent.procs > 1 ? \` <span class="mut">(\${d.agent.procs} instances)</span>\` : ""}</td></tr>
      \${(d.services || []).filter((s) => s.port).map((s) => \`<tr><td class="k">:\${s.port}</td><td>\${s.up ? '<span class="ok-t">listening ✓</span>' : '<span class="mut">down</span>'} <span class="mut">\${esc(s.name || "")}</span></td></tr>\`).join("")}
      \${d.envFiles.length ? \`<tr><td class="k">env files</td><td class="mono">\${d.envFiles.map((f) => f.exists ? esc(f.path) : \`<span class="bad-t">\${esc(f.path)} missing</span>\`).join(", ")}</td></tr>\` : ""}
    </table>\`;

  const deployBody = d.lastPush
    ? \`<table><tr><td class="k">last push</td><td>\${esc(d.lastPush.age)} <span class="mut">(\${esc(d.lastPush.date.slice(0, 10))}, \${esc(d.lastPush.ref)})</span></td></tr></table>
       <div class="mut" style="margin-top:6px">Tip of \${esc(d.lastPush.ref)} as of the last fetch — for push-to-deploy projects this is the last PROD trigger.</div>\`
    : '<span class="mut">no remote branch found</span>';

  const commitsBody = d.commits.length
    ? d.commits.map((c) => \`<div class="commit"><span class="h mono">\${esc(c.hash)}</span><span>\${esc(c.subject)}</span><span class="a">\${esc(c.age)}</span></div>\`).join("")
    : '<span class="mut">no commits</span>';

  const actionsBody = d.actions.length
    ? \`<table>\${d.actions.map((a) => {
        const btn = a.tier === "manual"
          ? \`<button class="runbtn" onclick="copyCmd(\${JSON.stringify("cd " + d.root + " && " + a.cmd).replace(/"/g, "&quot;")}, this)">copy</button>\`
          : \`<button class="runbtn" id="act-\${esc(a.name)}" onclick="runAction('\${esc(a.name)}')">run</button>\`;
        return \`<tr><td class="k">\${esc(a.name)}</td><td>\${btn} <span class="tier \${a.tier}">\${a.tier}</span> <code>\${esc(a.cmd)}</code>\${a.window ? \` <span class="mut">→ tmux:\${esc(a.window)}</span>\` : ""}</td></tr>\`;
      }).join("")}</table>
      <div id="runout">\${runOutHtml}</div>
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
          if (q.done) return \`<div class="plq done">✓ <s>\${esc(q.text)}</s></div>\`;
          qi++;
          return \`<div class="plq">? \${esc(q.text)}
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
              if (t.done) return \`<span class="tk done"><s>\${esc(t.text)}</s></span>\`;
              const wi = window._planTickets.push({ feature: f.name, text: t.text }) - 1;
              return \`<button class="tk tkbtn" title="start implementing this ticket" onclick="workTicket(\${wi})">▸ \${esc(t.text)}</button>\`;
            }).join("");
          return \`<div class="feat \${fd ? "done" : ""}">
            <div class="fhead">\${fd ? \`<s>\${esc(f.name)}</s>\` : esc(f.name)}
              <span class="fprog"><span class="fbar"><span style="width:\${total ? Math.round((done / total) * 100) : 0}%"></span></span> \${done}/\${total}</span></div>
            <div class="ftickets">\${tickets || '<span class="mut">no tickets yet</span>'}</div></div>\`;
        }).join("")
      : "";
    planBody = (dirHtml + featHtml) || '<span class="mut">plan.md found but empty — add ## Direction and ## Features sections</span>';
  } else {
    planBody = '<span class="mut">no plan.md — create one at the repo root: <code>## Direction</code> with checkbox questions, <code>## Features</code> with <code>### feature</code> blocks of checkbox tickets. Done items get struck through and sink automatically.</span>';
  }

  const clBody = d.changelog
    ? \`<pre>\${esc(d.changelog.text)}</pre>\`
    : '<span class="mut">no changelog found (looked for CHANGELOG.md, docs/changelog.md — or set <code>changelog:</code> in .project-cockpit.yml)</span>';

  document.getElementById("main").innerHTML = \`
    <header>
      <div class="path mono">\${esc(d.root)}</div>
      <h2>\${esc(d.name)}</h2>
      \${d.focus ? \`<p class="focus">\${esc(d.focus)}</p>\` : ""}
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
  if (confirm("Saved to plan.md: question checked with your answer, and a ticket added to '### Implementation queue'. Nothing is running yet.\\n\\nStart implementation NOW?\\n\\nOK — opens a live Claude Code session in " + selected + "'s tmux workspace (new 'impl' window), briefed with this decision. It starts working immediately; watch or steer it with: cockpit go " + selected + "\\n\\nCancel — leave it as a queued ticket. Start it later yourself: cockpit go " + selected + ", then in the agent tab ask Claude to work the Implementation queue in plan.md.")) {
    const ir = await fetch("/api/plan/implement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected, question, answer }) });
    const id = await ir.json();
    if (!ir.ok) alert(id.error || "failed to start implementation");
    else alert("Implementation running in tmux window \\"impl\\" — watch it with: cockpit go " + selected + "\\nThe agent indicator on this dashboard will show it as working ✳.");
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
    html = \`<p>A Claude Code session in this project finished its turn — or is stalled at a permission prompt. This one is genuinely yours: it needs your reply, so there is nothing safe to automate.</p>
      <p><strong>Go to it:</strong></p>\${fixCmdHtml("cockpit go " + d.name)}
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
  if (!confirm("Start implementing this ticket?\\n\\n  " + t.text + "\\n  (feature: " + t.feature + ")\\n\\nOpens an attended Claude Code session in " + selected + "'s tmux 'impl' window, briefed with this ticket. It will check the box in plan.md when done. It will not push.")) return;
  const r = await fetch("/api/plan/work", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: selected, feature: t.feature, ticket: t.text }) });
  const d = await r.json();
  if (!r.ok) { alert(d.error || "failed"); return; }
  alert("Working on it — tmux window \\"impl\\" in " + selected + ". The agent indicator will show ✳ while it works; watch with: cockpit go " + selected);
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

if (import.meta.main) startServer(Number(process.argv[2]) || 4400);
