// cockpit dashboard — Phase 2 (Design B): read-only localhost web UI.
// One process, no daemon state: every request recomputes live state via state.ts.
// Start with `cockpit dash` or `bun src/server.ts`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Project,
  allProjects, attentionItems, gitState, lastPush, localService,
  portListening, readChangelog, recentCommits, tmuxSessionAlive, tmuxWindows,
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

export function startServer(port = 4400) {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/projects") {
        const projects = await Promise.all(allProjects().map(projectSummary));
        projects.sort((a, b) => (b.attention.length ? 1 : 0) - (a.attention.length ? 1 : 0) || a.name.localeCompare(b.name));
        return json(projects);
      }
      const m = url.pathname.match(/^\/api\/project\/(.+)$/);
      if (m) {
        const name = decodeURIComponent(m[1]).toLowerCase();
        const p = allProjects().find((x) => x.name.toLowerCase() === name);
        if (!p) return new Response("not found", { status: 404 });
        return json(await projectDetail(p));
      }
      if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`cockpit dashboard: http://localhost:${server.port} (read-only — Ctrl-C to stop)`);
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
    --bad: #b42318; --chip-bg: #eef1f4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14181d; --surface: #1c2128; --border: #303842;
      --ink: #e8ecf1; --ink-2: #a6b0bc; --ink-3: #6f7a87;
      --accent: #6ea8fe; --ok: #4ade80; --warn-bg: #3a2e14; --warn-ink: #ffd561; --warn-border: #6b5a1e;
      --bad: #f87171; --chip-bg: #262d36;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
  .layout { display: flex; min-height: 100vh; }
  aside { width: 250px; flex: none; border-right: 1px solid var(--border); background: var(--surface); padding: 12px 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  aside h1 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); margin: 4px 16px 10px; }
  .proj { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--ink); padding: 9px 16px; cursor: pointer; font: inherit; border-left: 3px solid transparent; }
  .proj:hover { background: var(--chip-bg); }
  .proj.sel { border-left-color: var(--accent); background: var(--chip-bg); }
  .proj .nm { font-weight: 600; display: flex; align-items: center; gap: 7px; }
  .proj .sub { color: var(--ink-2); font-size: 12px; margin-left: 17px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn-ink); }
  main { flex: 1; padding: 22px 26px; max-width: 980px; }
  header .path { color: var(--ink-3); font-size: 12px; }
  header h2 { margin: 2px 0 2px; font-size: 22px; }
  .focus { color: var(--ink-2); font-style: italic; margin: 0 0 10px; }
  .links { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 4px; }
  .links a { text-decoration: none; color: var(--accent); background: var(--chip-bg); border: 1px solid var(--border); padding: 4px 11px; border-radius: 999px; font-size: 13px; }
  .links a:hover { border-color: var(--accent); }
  .attn { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
  .attn span { background: var(--warn-bg); color: var(--warn-ink); border: 1px solid var(--warn-border); padding: 3px 10px; border-radius: 6px; font-size: 13px; font-weight: 500; }
  .calm { color: var(--ok); font-size: 13px; margin: 14px 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; margin-top: 10px; }
  details { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 0; overflow: hidden; }
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
</style>
</head>
<body>
<div class="layout">
  <aside><h1>Projects</h1><div id="side"></div></aside>
  <main id="main"><div class="empty">Loading…</div></main>
</div>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
let selected = decodeURIComponent(location.hash.slice(1)) || null;
let openState = {};

function rememberOpen() {
  document.querySelectorAll("main details[id]").forEach((d) => { openState[d.id] = d.open; });
}
function card(id, title, hint, bodyHtml, wide) {
  const open = openState[id] !== undefined ? openState[id] : true;
  return \`<details id="\${id}" \${open ? "open" : ""} \${wide ? 'class="wide"' : ""}>
    <summary>\${esc(title)}\${hint ? \`<span class="hint">\${esc(hint)}</span>\` : ""}</summary>
    <div class="body">\${bodyHtml}</div></details>\`;
}

async function refresh() {
  const projects = await (await fetch("/api/projects")).json();
  if (!selected && projects.length) selected = projects[0].name;
  document.getElementById("side").innerHTML = projects.map((p) => \`
    <button class="proj \${p.name === selected ? "sel" : ""}" onclick="pick('\${esc(p.name)}')">
      <div class="nm"><span class="dot \${p.attention.length ? "warn" : "ok"}"></span>\${esc(p.name)}</div>
      <div class="sub">\${esc(p.branch || "—")}\${p.session ? " · tmux" : ""}\${p.devUp ? " · :" + p.devPort : ""}\${p.attention.length ? " · ▲ " + p.attention.length : ""}</div>
    </button>\`).join("");
  if (selected) renderDetail();
}

function pick(name) { selected = name; location.hash = encodeURIComponent(name); openState = {}; refresh(); }

async function renderDetail() {
  const r = await fetch("/api/project/" + encodeURIComponent(selected));
  if (!r.ok) { document.getElementById("main").innerHTML = '<div class="empty">Project not found</div>'; return; }
  const d = await r.json();
  rememberOpen();

  const links = [
    d.repo && \`<a href="\${esc(d.repo)}" target="_blank">GitHub ↗</a>\`,
    ...(d.services || []).filter((s) => s.url && s.kind !== "local").map((s) => \`<a href="\${esc(s.url)}" target="_blank">\${esc(s.name || s.kind)} ↗</a>\`),
    ...(d.services || []).filter((s) => s.url && s.kind === "local").map((s) => \`<a href="\${esc(s.url)}" target="_blank">local dev ↗</a>\`),
    d.notes && \`<a href="\${esc(d.notes)}">Obsidian ↗</a>\`,
    \`<a href="cursor://file/\${esc(d.root)}">Cursor ↗</a>\`,
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
      <tr><td class="k">tmux</td><td>\${d.session ? \`<span class="ok-t">session running ✓</span> <span class="mut">(\${d.windows.map(esc).join(", ")})</span>\` : \`<span class="mut">no session — <code>cockpit go \${esc(d.name)}</code></code></span>\`}</td></tr>
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
    ? \`<table>\${d.actions.map((a) => \`<tr><td class="k">\${esc(a.name)}</td><td><span class="tier \${a.tier}">\${a.tier}</span> <code>\${esc(a.cmd)}</code></td></tr>\`).join("")}</table>
       <div class="mut" style="margin-top:6px">Run via <code>cockpit run \${esc(d.name)} &lt;action&gt;</code> — this dashboard is read-only.</div>\`
    : '<span class="mut">no actions declared</span>';

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
    <footer>read-only · refreshes every 10s · state recomputed live from git/tmux/lsof</footer>\`;
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

if (import.meta.main) startServer(Number(process.argv[2]) || 4400);
