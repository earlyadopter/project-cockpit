// cockpit dashboard — Phase 2 (read-only views) + Phase 3 (actions, palette, audit).
// One process, no daemon state: every request recomputes live state via state.ts.
// Tier enforcement lives HERE, server-side: safe runs, confirm needs an explicit
// confirmed flag (set by the UI dialog), manual is always refused with the command
// to copy. Binds 127.0.0.1 only; non-GET requests must be same-origin.
// Start with `cockpit dash` or `bun src/server.ts`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Project,
  allProjects, attentionItems, audit, gitState, lastPush, localService, openTarget,
  portListening, readAudit, readChangelog, recentCommits, runInline, sendToWindow,
  tmuxSessionAlive, tmuxWindows,
} from "./state.ts";

async function projectSummary(p: Project) {
  const svc = localService(p);
  const [git, session, devUp] = await Promise.all([
    gitState(p.root),
    tmuxSessionAlive(p.name),
    svc?.port ? portListening(svc.port) : Promise.resolve(null),
  ]);
  return {
    name: p.name, root: p.root, focus: p.cfg.focus ?? "", branch: git.branch,
    dirty: git.dirty.length, ahead: git.ahead, behind: git.behind,
    session, devPort: svc?.port ?? null, devUp,
    attention: attentionItems(p, git),
  };
}

async function projectDetail(p: Project) {
  const [summary, git, windows, push, commits] = await Promise.all([
    projectSummary(p),
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
  return {
    ...summary,
    repo: p.cfg.repo ?? "", notes: p.cfg.notes ?? "", hasConfig: p.hasConfig,
    lastCommit: git.lastCommit, lastCommitAge: git.lastCommitAge,
    hasUpstream: git.hasUpstream, hasRemote: git.hasRemote,
    dirtyFiles: git.dirty.slice(0, 20), dirtyTotal: git.dirty.length,
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
        const projects = await Promise.all(allProjects().map(projectSummary));
        projects.sort((a, b) => (b.attention.length ? 1 : 0) - (a.attention.length ? 1 : 0) || a.name.localeCompare(b.name));
        return json(projects);
      }

      const m = url.pathname.match(/^\/api\/project\/(.+)$/);
      if (req.method === "GET" && m) {
        const p = getProject(m[1]);
        if (!p) return json({ error: "not found" }, 404);
        return json(await projectDetail(p));
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
  .attn span { background: var(--warn-bg); color: var(--warn-ink); border: 1px solid var(--warn-border); padding: 3px 10px; border-radius: 6px; font-size: 13px; font-weight: 500; }
  .calm { color: var(--ok); font-size: 13px; margin: 14px 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; margin-top: 10px; }
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
  #palette { position: fixed; inset: 0; background: var(--overlay); display: none; z-index: 10; }
  #palette.open { display: block; }
  #palette .box { width: min(560px, 90vw); margin: 12vh auto 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 18px 50px rgba(0,0,0,.3); }
  #palette input { width: 100%; border: 0; outline: 0; background: none; color: var(--ink); font: 16px inherit; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  #palette .items { max-height: 46vh; overflow-y: auto; }
  #palette .item { padding: 9px 16px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
  #palette .item.hot, #palette .item:hover { background: var(--chip-bg); }
  #palette .item .k2 { color: var(--ink-3); font-size: 12px; margin-left: auto; flex: none; }
</style>
</head>
<body>
<div class="layout">
  <aside>
    <h1>Projects</h1><div id="side"></div>
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
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
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
      <div class="sub">\${esc(p.branch || "—")}\${p.session ? " · tmux" : ""}\${p.devUp ? " · :" + p.devPort : ""}\${p.attention.length ? " · ▲ " + p.attention.length : ""}</div>
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
    ? \`<div class="attn">\${d.attention.map((a) => \`<span>▲ \${esc(a)}</span>\`).join("")}</div>\`
    : \`<div class="calm">✓ nothing needs attention</div>\`;

  const gitBody = d.branch ? \`<table>
      <tr><td class="k">branch</td><td class="mono">\${esc(d.branch)}\${d.hasUpstream ? \` <span class="mut">↑\${d.ahead} ↓\${d.behind}</span>\` : \` <span class="mut">(\${d.hasRemote ? "no upstream" : "no remote"})</span>\`}</td></tr>
      <tr><td class="k">last commit</td><td>\${esc(d.lastCommit)} <span class="mut">(\${esc(d.lastCommitAge)})</span></td></tr>
      \${d.dirtyTotal ? \`<tr><td class="k">dirty (\${d.dirtyTotal})</td><td><pre>\${esc(d.dirtyFiles.join("\\n"))}\${d.dirtyTotal > 20 ? "\\n…" : ""}</pre></td></tr>\` : \`<tr><td class="k">worktree</td><td class="ok-t">clean ✓</td></tr>\`}
    </table>\` : '<span class="mut">not a git repository</span>';

  const wsBody = \`<table>
      <tr><td class="k">tmux</td><td>\${d.session ? \`<span class="ok-t">session running ✓</span> <span class="mut">(\${d.windows.map(esc).join(", ")})</span>\` : \`<span class="mut">no session — <code>cockpit go \${esc(d.name)}</code></span>\`}</td></tr>
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
      \${card("git", "Git", d.branch, gitBody)}
      \${card("ws", "Workspace", d.session ? "tmux ✓" : "", wsBody)}
      \${card("deploy", "Deploy", d.lastPush ? d.lastPush.age : "", deployBody)}
      \${card("commits", "Recent commits", "", commitsBody)}
      \${card("changelog", "Changelog", d.changelog ? d.changelog.path : "", clBody, true)}
      \${card("actions", "Actions", "", actionsBody, true)}
    </div>
    <footer>refreshes every 10s · state recomputed live from git/tmux/lsof · <kbd>⌘K</kbd> palette</footer>\`;
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

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

if (import.meta.main) startServer(Number(process.argv[2]) || 4400);
