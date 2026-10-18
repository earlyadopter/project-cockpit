// Home screen client. Everything comes from GET /api/home (+ /api/discover); every
// change is a POST that edits one file (plan.md, ABOUT.md, portfolio.md, registry)
// and then re-reads. No client-side state survives except per-viewer conveniences
// in localStorage (filters live in the URL hash).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// A JS string literal that survives being inside an HTML attribute: JSON-quote it,
// then HTML-escape — the parser decodes &quot; back before the handler runs.
const jsArg = (s) => esc(JSON.stringify(String(s ?? "")));
const STATUS = { "needs-you": "Needs you", running: "Running", active: "Active", cooling: "Cooling", unplanned: "Unplanned", dormant: "Dormant", done: "Done", parked: "Parked" };
const STATUS_HINT = {
  "needs-you": "an agent is waiting or a Direction question is open",
  running: "a Claude Code session is working",
  active: "open tickets, activity in the last 7 days",
  cooling: "open tickets, quiet for 7–30 days",
  unplanned: "recent activity but nothing queued in plan.md",
  dormant: "quiet for 30+ days",
  done: "every ticket checked, quiet for a week",
  parked: "parked in portfolio.md",
};
const TYPE = { agent: "Agent", answer: "Answer", run: "Run manually", fix: "Fix", you: "Your task", ticket: "Ticket", decide: "Decide" };
const GROUPS = [["Now", "what you are working on — at most 3"], ["Next", "up after Now"], ["Later", "someday"], [null, "not in portfolio.md yet — drag a tile into a group"], ["Parked", "deliberately on hold"]];

let D = null, DISC = null, lastRefreshAt = Date.now(), dragging = null, subfOpen = null;
let IT = [], QI = [], TK = [];
const expanded = new Set();
let ui = readHash();

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const set = (k) => new Set((h.get(k) || "").split(",").filter(Boolean));
  return { s: set("s"), k: set("k"), g: h.get("g") === "status" ? "status" : "priority" };
}
function writeHash() {
  const h = new URLSearchParams();
  if (ui.s.size) h.set("s", [...ui.s].join(","));
  if (ui.k.size) h.set("k", [...ui.k].join(","));
  if (ui.g === "status") h.set("g", "status");
  const str = h.toString();
  history.replaceState(null, "", str ? "#" + str : location.pathname);
}
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};
const today = () => new Date().toISOString().slice(0, 10);

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let d = {};
  try { d = await r.json(); } catch { /* empty */ }
  return { ok: r.ok, status: r.status, d };
}
let toastT;
function toast(msg, bad) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show" + (bad ? " bad" : "");
  clearTimeout(toastT);
  toastT = setTimeout(() => (el.className = ""), bad ? 6000 : 2600);
}
async function act(path, body, okMsg) {
  const r = await post(path, body);
  if (!r.ok) { toast(r.d.error || "failed (" + r.status + ")", true); return null; }
  if (okMsg) toast(okMsg);
  await refresh(true);
  return r.d;
}
function copy(text) { navigator.clipboard.writeText(text).then(() => toast("copied: " + text)); }

// ---------- refresh: never clobber typing, a drag, a modal or an open menu ----------
function busy() {
  if (dragging) return true;
  if (document.getElementById("modal").classList.contains("open")) return true;
  if (document.querySelector(".dd.open")) return true;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && document.getElementById("app").contains(ae)) return true;
  return [...document.querySelectorAll("#app input.txt, #app textarea.txt")].some((el) => el.value.trim());
}
async function refresh(force) {
  if (!force && busy()) return;
  try {
    const [h, d] = await Promise.all([fetch("/api/home"), fetch("/api/discover")]);
    if (!h.ok) throw new Error("HTTP " + h.status);
    D = await h.json();
    DISC = d.ok ? await d.json() : [];
  } catch (e) {
    document.getElementById("sum").textContent = "dashboard unreachable — " + e.message;
    return;
  }
  render();
  lastRefreshAt = Date.now();
}

const byName = (n) => D.projects.find((p) => p.name === n);
function visible() {
  return D.projects.filter((p) => (!ui.s.size || ui.s.has(p.status)) && (!ui.k.size || ui.k.has(p.kind)));
}
const filtered = () => ui.s.size > 0 || ui.k.size > 0;

function render() {
  const P = D.projects;
  const n = (s) => P.filter((p) => p.status === s).length;
  document.getElementById("sum").textContent = P.length
    ? `${P.length} project${P.length > 1 ? "s" : ""} · ${n("needs-you")} need${n("needs-you") === 1 ? "s" : ""} you · ${n("running")} running · ${n("active")} active`
    : "no projects yet";
  document.getElementById("pfpath").textContent = D.portfolio.path.replace(/^\/Users\/[^/]+/, "~");
  IT = []; QI = []; TK = [];
  let html = "";
  if (!P.length) {
    html = welcomeHtml() + subfoldersHtml(true);
  } else {
    const vis = visible();
    html += barHtml();
    if (filtered()) html += todoHtml(vis);
    else html += `<div class="cols">${queueHtml()}${nowHtml()}</div>` + hintsHtml();
    html += groupsHtml(vis);
    html += subfoldersHtml(false);
    if (!filtered()) html += `<div class="cols">${recentHtml()}${stepsHtml()}</div>`;
  }
  document.getElementById("app").innerHTML = html;
}

// ---------- filter bar ----------
function barHtml() {
  const count = (s) => D.projects.filter((p) => p.status === s).length;
  const chips = [`<button class="chip ${filtered() ? "" : "on"}" onclick="setFilter(null, event)">All<span class="n">${D.projects.length}</span></button>`];
  for (const s of D.statuses) {
    const c = count(s);
    if (!c && !ui.s.has(s)) continue;
    chips.push(`<button class="chip ${ui.s.has(s) ? "on" : ""}" title="${esc(STATUS_HINT[s])} — ⌘/shift-click to combine" onclick="setFilter('${s}', event)">${STATUS[s]}<span class="n">${c}</span></button>`);
  }
  const box = (set, v, label) => `<label><input type="checkbox" ${set.has(v) ? "checked" : ""} onchange="toggleSet('${set === ui.s ? "s" : "k"}','${v}')"> ${label}</label>`;
  const menu = `<div class="dd" id="dd"><button class="chip" onclick="event.stopPropagation(); document.getElementById('dd').classList.toggle('open')">Filters${ui.s.size + ui.k.size ? " (" + (ui.s.size + ui.k.size) + ")" : ""} ▾</button>
    <div class="ddmenu" onclick="event.stopPropagation()"><div class="sec">Status</div>${D.statuses.map((s) => box(ui.s, s, STATUS[s] + ` <span class="mut">${count(s)}</span>`)).join("")}
    <div class="sec">Kind</div>${box(ui.k, "code", "Code")}${box(ui.k, "content", "Content (markdown only)")}
    <div style="margin-top:8px"><button class="link" onclick="setFilter(null)">clear all</button></div></div></div>`;
  const seg = `<span class="seg"><button class="${ui.g === "priority" ? "on" : ""}" onclick="setGroup('priority')">By priority</button><button class="${ui.g === "status" ? "on" : ""}" onclick="setGroup('status')">By status</button></span>`;
  return `<div class="bar">${chips.join("")}<span class="sp"></span>${menu}${seg}</div>`;
}
function setFilter(s, ev) {
  if (s === null) { ui.s.clear(); ui.k.clear(); }
  else if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) ui.s.has(s) ? ui.s.delete(s) : ui.s.add(s);
  else if (ui.s.size === 1 && ui.s.has(s)) ui.s.clear();
  else { ui.s.clear(); ui.s.add(s); }
  writeHash(); render();
}
function toggleSet(which, v) { const set = which === "s" ? ui.s : ui.k; set.has(v) ? set.delete(v) : set.add(v); writeHash(); render(); document.getElementById("dd")?.classList.add("open"); }
function setGroup(g) { ui.g = g; writeHash(); render(); }
document.addEventListener("click", () => document.getElementById("dd")?.classList.remove("open"));
// back/forward or a pasted #s=… link: the hash is the filter state
window.addEventListener("hashchange", () => { const h = readHash(); ui.s = h.s; ui.k = h.k; ui.g = h.g; if (D) render(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); document.getElementById("dd")?.classList.remove("open"); } });

// ---------- work items (filtered view) ----------
function itemActions(it, i) {
  const p = it.project;
  switch (it.type) {
    case "agent": return `<button class="mini" onclick="jump(${jsArg(p)})">↦ jump</button>`;
    case "answer": return `<button class="mini" onclick="answerQ(${i})">answer…</button>`;
    case "run": return it.cmd ? `<button class="mini" onclick="copy(IT[${i}].cmd)">copy command</button>` : "";
    case "fix": return (it.cmd ? `<button class="mini" onclick="copy(IT[${i}].cmd)">copy command</button>` : "") + `<a class="mini" href="/project#${encodeURIComponent(p)}">open ›</a>`;
    case "ticket": return `<button class="mini" onclick="workTicket(${i})" title="start an attended Claude session on it">work on it</button>`;
    case "decide": return `<button class="mini" onclick="act('/api/portfolio/reviewed', {}, 'portfolio marked reviewed')">mark reviewed</button>`;
    default: return "";
  }
}
function itemRow(it, state) {
  const i = IT.push(it) - 1;
  const p = it.project ? byName(it.project) : null;
  const checked = state !== "open";
  const pn = it.project ? `<span class="pn"><span class="pdot" style="background:${esc(p?.color || "var(--ink-3)")}"></span>${esc(it.project)}</span>` : "";
  const note = state === "cleared" ? `<span class="mut" style="font-size:11.5px">✓ done (cleared on its own)</span>` : "";
  return `<div class="row ${checked ? "done" : ""}"><input type="checkbox" class="cb" ${checked ? "checked" : ""} ${state === "cleared" ? "disabled" : ""} onchange="checkItem(${i}, this.checked)"
      title="${it.type === "ticket" || it.type === "you" ? "checks the ticket in plan.md" : "tick it off — it also ticks itself when the state clears"}">
    <span class="type ${it.type}">${TYPE[it.type] || it.type}</span>${pn}<span class="t multi" title="${esc(it.text)}">${esc(it.text)}</span>${checked ? note : itemActions(it, i)}</div>
    ${it.detail && !checked ? `<div class="itemx detail">${esc(it.detail)}</div>` : ""}`;
}
function todoHtml(vis) {
  const names = new Set(vis.map((p) => p.name));
  const inView = (it) => (it.project ? names.has(it.project) : !ui.s.size || ui.s.has("needs-you"));
  const cur = D.items.filter(inView);
  const st = store.get("cockpit.todo.v1", null);
  const s = st && st.day === today() ? st : { day: today(), seen: {}, checked: {} };
  const curIds = new Set(cur.map((it) => it.id));
  for (const it of cur) s.seen[it.id] = it;
  const cleared = Object.values(s.seen).filter((it) => !curIds.has(it.id) && inView(it));
  for (const id of Object.keys(s.checked)) if (!curIds.has(id)) delete s.checked[id];
  store.set("cockpit.todo.v1", s);
  const open = cur.filter((it) => !s.checked[it.id]);
  const ticked = cur.filter((it) => s.checked[it.id]);
  const total = cur.length + cleared.length, done = ticked.length + cleared.length;
  const pct = total ? Math.round((done / total) * 100) : 100;
  const label = ui.s.size ? [...ui.s].map((x) => STATUS[x]).join(" + ") : "this view";
  return `<div class="card"><h2>To do in ${esc(label)}<span class="prog">${done} of ${total} done<span class="pbar"><span style="width:${pct}%"></span></span></span></h2>
    ${total ? open.map((it) => itemRow(it, "open")).join("") + ticked.map((it) => itemRow(it, "ticked")).join("") + cleared.map((it) => itemRow(it, "cleared")).join("")
      : `<div class="mut">Nothing to do for these projects right now.</div>`}
    <div class="note" style="margin-top:8px">Tickets check off in plan.md. Everything else ticks itself once the state clears (pushed, committed, answered) — or tick it by hand. Ticks reset daily.</div></div>`;
}
async function checkItem(i, on) {
  const it = IT[i];
  if (!it) return;
  if (it.type === "ticket" || it.type === "you") {
    if (!on) return;
    await act("/api/plan/check", { project: it.project, feature: it.feature, text: it.text, done: true }, "checked in plan.md");
    return;
  }
  const s = store.get("cockpit.todo.v1", { day: today(), seen: {}, checked: {} });
  if (on) s.checked[it.id] = true; else delete s.checked[it.id];
  store.set("cockpit.todo.v1", s);
  render();
}

// ---------- All view: Up next queue + what needs you now ----------
function queueHtml() {
  const pf = D.portfolio;
  const rows = pf.queue.map((q) => {
    const i = QI.push(q) - 1;
    const p = q.name ? byName(q.name) : null;
    return `<div class="row" draggable="true" data-q="${i}" ondragstart="dragStart(event,{kind:'queue',i:${i}})" ondragend="dragEnd()" ondragover="dragOver(event,'queue')" ondragleave="this.classList.remove('drag-over')" ondrop="dropQueue(event,${i})">
      <span class="handle" title="drag to reorder">⋮⋮</span>
      <input type="checkbox" class="cb" ${q.stale ? "disabled" : ""} title="done — checks it in plan.md and drops it from the queue" onchange="queueDone(${i})">
      <span class="pn"><span class="pdot" style="background:${esc(p?.color || "var(--ink-3)")}"></span>${esc(q.name || q.project)}</span>
      <span class="t" title="${esc(q.text)}">${esc(q.text)}</span>${q.you ? `<span class="you">@you</span>` : ""}${q.stale ? `<span class="stale" title="${esc(q.stale)}">stale</span>` : ""}
      <button class="mini ghost" title="up" onclick="queueMove(${i},-1)">▲</button><button class="mini ghost" title="down" onclick="queueMove(${i},1)">▼</button><button class="mini ghost" title="remove from the queue (plan.md untouched)" onclick="queueRemove(${i})">✕</button></div>`;
  }).join("");
  const opts = D.projects.filter((p) => p.openTickets.length).map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
  const reviewed = pf.reviewed ? `reviewed ${esc(pf.reviewed)}` : "never reviewed";
  return `<div class="card"><h2>Up next<span class="hint">across all projects · ${reviewed} · <button class="link" onclick="act('/api/portfolio/reviewed', {}, 'marked reviewed')">mark reviewed</button></span></h2>
    ${rows || `<div class="mut">The queue is empty. Add the few tickets that matter most this week, from any project.</div>`}
    <div class="addrow"><select class="txt" id="qproj" onchange="fillTickets()"><option value="">project…</option>${opts}</select>
      <input class="txt" id="qtext" list="qlist" placeholder="pick or type a ticket" style="flex:1;min-width:180px"><datalist id="qlist"></datalist>
      <label class="note"><input type="checkbox" id="qyou"> @you</label><button class="btn" onclick="queueAdd()">add</button></div></div>`;
}
function fillTickets() {
  const p = byName(document.getElementById("qproj").value);
  document.getElementById("qlist").innerHTML = (p?.openTickets || []).map((t) => `<option value="${esc(t.text)}">`).join("");
}
async function queueAdd() {
  const project = document.getElementById("qproj").value;
  const text = document.getElementById("qtext").value.trim();
  const you = document.getElementById("qyou").checked;
  if (!project || !text) { toast("pick a project and a ticket", true); return; }
  const p = byName(project);
  const known = p.openTickets.some((t) => t.text === text || t.text.startsWith(text));
  if (!known) {
    if (!confirm(`"${text}" isn't an open ticket in ${project}'s plan.md yet.\n\nAdd it there (feature "Inbox") and queue it?`)) return;
    document.getElementById("qtext").value = "";
    await act("/api/plan/add", { project, feature: "Inbox", text, queue: true, you }, "added to plan.md and queued");
    return;
  }
  document.getElementById("qtext").value = "";
  await act("/api/portfolio/queue", { op: "add", project, text, you }, "queued");
}
const qref = (i) => ({ project: QI[i].project, text: QI[i].text });
async function queueMove(i, delta) {
  const to = i + delta;
  if (to < 0 || to >= QI.length) return;
  await act("/api/portfolio/queue", { op: "move", ...qref(i), index: to });
}
async function queueRemove(i) { await act("/api/portfolio/queue", { op: "remove", ...qref(i) }, "removed from the queue"); }
async function queueDone(i) {
  const q = QI[i];
  await act("/api/plan/check", { project: q.name, feature: q.feature, text: q.ticket, done: true }, "checked in plan.md");
}
function nowHtml() {
  const urgent = D.items.filter((it) => ["agent", "answer", "run", "you", "decide"].includes(it.type));
  const rows = urgent.slice(0, 7).map((it) => itemRow(it, "open")).join("");
  return `<div class="card"><h2>Needs you now<span class="hint">${urgent.length} item${urgent.length === 1 ? "" : "s"} · <button class="link" onclick="setFilter('needs-you')">open the Needs-you list</button></span></h2>
    ${rows || `<div class="mut">Nothing is waiting on you. ✓</div>`}${urgent.length > 7 ? `<div class="note" style="margin-top:6px">+ ${urgent.length - 7} more in the Needs-you view</div>` : ""}</div>`;
}
function hintsHtml() {
  if (!D.hints.length) return "";
  return `<div class="hints">${D.hints.map((h) => `<div class="hintrow">⚑ <span>${esc(h.text)}</span></div>`).join("")}</div>`;
}

// ---------- project tiles ----------
function groupsHtml(vis) {
  const statusRank = (s) => D.statuses.indexOf(s);
  let groups;
  if (ui.g === "status") {
    groups = D.statuses.map((s) => ({ key: s, title: STATUS[s], sub: STATUS_HINT[s], tiles: vis.filter((p) => p.status === s), drop: false }));
  } else {
    groups = GROUPS.map(([b, sub]) => ({
      key: b, title: b || "Unranked", sub,
      tiles: vis.filter((p) => (p.bucket || null) === b).sort((x, y) => b ? x.bucketIndex - y.bucketIndex : statusRank(x.status) - statusRank(y.status) || x.name.localeCompare(y.name)),
      drop: true,
    }));
  }
  return groups.filter((g) => g.tiles.length || (g.drop && !filtered())).map((g) => `<div class="group">
    <div class="ghead"><h3>${esc(g.title)}</h3><span class="gsub">${esc(g.sub || "")}${g.key === "Now" ? ` · ${g.tiles.length}/3` : ""}</span></div>
    <div class="tiles" ${g.drop ? `data-bucket="${esc(g.key || "")}" ondragover="dragOver(event,'tile')" ondragleave="this.classList.remove('drop')" ondrop="dropTile(event,null)"` : ""}>
      ${g.tiles.map(tileHtml).join("") || `<div class="mut" style="padding:12px 4px">drop a project here</div>`}</div></div>`).join("");
}
function tileHtml(p) {
  const nm = esc(p.name);
  const enc = encodeURIComponent(p.name);
  const wait = p.agent.state === "waiting" && p.agent.wait ? " · " + esc(p.agent.wait) : "";
  const meta = [p.kind === "code" ? (p.branch && p.branch !== "?" ? p.branch : "no git") : "", p.activityAge ? "last activity " + p.activityAge : "no activity seen", p.session ? "tmux" : "", p.devUp ? ":" + p.devPort : ""].filter(Boolean).join(" · ");
  const next = p.openTickets[0];
  const isOpen = expanded.has(p.name);
  const counts = [
    `${p.openTickets.length} open ticket${p.openTickets.length === 1 ? "" : "s"}`,
    p.questions.length ? `${p.questions.length} question${p.questions.length > 1 ? "s" : ""}` : "",
    p.ideas.length ? `${p.ideas.length} idea${p.ideas.length > 1 ? "s" : ""}` : "",
    p.dirty ? `${p.dirty} uncommitted` : "", p.ahead ? `${p.ahead} unpushed` : "", p.behind ? `${p.behind} behind` : "",
  ].filter(Boolean).join(" · ");
  const draggable = ui.g === "priority";
  return `<div class="tile" data-p="${nm}" ${draggable ? `ondragstart="dragStart(event,{kind:'tile',name:this.dataset.p})" ondragend="this.draggable=false;this.classList.remove('dragging');dragEnd()" ondragover="dragOver(event,'tile')" ondragleave="this.classList.remove('drag-over')" ondrop="dropTile(event,this.dataset.p)"` : ""}>
    <div class="th"><span class="pdot" style="background:${esc(p.color)}"></span><a class="tn" href="/project#${enc}">${p.icon ? esc(p.icon) + " " : ""}${nm}</a>
      <span class="pill st-${p.status}" title="${esc(STATUS_HINT[p.status])}">${STATUS[p.status]}${wait}</span>${p.kind === "content" ? `<span class="kindtag">content</span>` : ""}
      ${draggable ? `<span class="grab" title="drag to re-prioritize" onmousedown="this.closest('.tile').draggable=true" ontouchstart="this.closest('.tile').draggable=true">⋮⋮</span>` : ""}</div>
    <div class="tag ${p.about?.title ? "" : "none"}" title="${esc(p.about?.description || "click to describe this project (writes ABOUT.md)")}" onclick="editAbout(${jsArg(p.name)})">${esc(p.about?.title || "+ add a one-line description")}</div>
    <div class="meta" title="${esc(p.root)}">${esc(meta)}</div>
    ${next ? `<div class="next" onclick="toggleTickets(${jsArg(p.name)})" title="${isOpen ? "hide" : "show"} all open tickets"><span class="lbl">${isOpen ? "▾" : "▸"} Next</span><span class="t">${esc(next.text)}</span></div>`
      : `<div class="next" onclick="toggleTickets(${jsArg(p.name)})"><span class="lbl">${isOpen ? "▾" : "▸"} Next</span><span class="t mut">no open tickets — add one, or Plan</span></div>`}
    ${isOpen ? ticketsHtml(p) : ""}
    <div class="counts">${esc(counts)}</div>
    <div class="btns"><button class="btn" onclick="ideate(${jsArg(p.name)})" title="capture ideas in plan.md ## Ideas">Ideate</button><button class="btn" onclick="planModal(${jsArg(p.name)})" title="turn an idea into a feature with tickets">Plan</button><button class="btn" onclick="terminal(${jsArg(p.name)})" title="raise this project's tmux session in iTerm2">Terminal</button><a class="btn open" href="/project#${enc}" title="project detail: git, workspace, actions, changelog">Open</a></div>
  </div>`;
}
function toggleTickets(name) { expanded.has(name) ? expanded.delete(name) : expanded.add(name); render(); }
function ticketsHtml(p) {
  const byF = new Map();
  for (const t of p.openTickets) { if (!byF.has(t.feature)) byF.set(t.feature, []); byF.get(t.feature).push(t); }
  let html = "";
  for (const [f, ts] of byF) {
    html += `<div class="fname">${esc(f)}</div>`;
    ts.forEach((t, k) => {
      const i = TK.push({ project: p.name, feature: f, text: t.text, prev: ts[k - 1]?.text, after: ts[k + 2]?.text, isLast: k === ts.length - 1, isSecondLast: k === ts.length - 2 }) - 1;
      html += `<div class="row" draggable="true" ondragstart="dragStart(event,{kind:'ticket',i:${i}})" ondragend="dragEnd()" ondragover="dragOver(event,'ticket',${i})" ondragleave="this.classList.remove('drag-over')" ondrop="dropTicket(event,${i})">
        <span class="handle" title="drag to re-prioritize inside this feature">⋮⋮</span><input type="checkbox" class="cb" title="done — checks it in plan.md" onchange="checkTicketRow(${i})">
        <span class="t" title="${esc(t.text)}">${esc(t.text)}</span>
        <button class="mini ghost" title="up" onclick="ticketMove(${i},-1)">▲</button><button class="mini ghost" title="down" onclick="ticketMove(${i},1)">▼</button>
        <button class="mini ghost" title="work on it: attended Claude session" onclick="workTicketRow(${i})">▶</button></div>`;
    });
  }
  const feats = p.features.map((f) => `<option>${esc(f)}</option>`).join("");
  const id = encodeURIComponent(p.name).replace(/%/g, "_");
  return `<div class="tickets">${html || `<div class="mut">no open tickets</div>`}
    <div class="addrow"><select class="txt" id="af-${id}" style="max-width:40%">${feats}<option value="__new">＋ new feature…</option></select>
      <input class="txt" id="at-${id}" placeholder="new ticket" style="flex:1" onkeydown="if(event.key==='Enter')addTicketRow(${jsArg(p.name)})"><button class="mini" onclick="addTicketRow(${jsArg(p.name)})">add</button></div></div>`;
}
async function addTicketRow(name) {
  const id = encodeURIComponent(name).replace(/%/g, "_");
  let feature = document.getElementById("af-" + id).value;
  const input = document.getElementById("at-" + id);
  const text = input.value.trim();
  if (!text) return;
  if (feature === "__new" || !feature) { feature = prompt("Name of the new feature:", "Inbox"); if (!feature) return; }
  input.value = "";
  await act("/api/plan/add", { project: name, feature, text }, "added to plan.md");
}
async function checkTicketRow(i) { const t = TK[i]; await act("/api/plan/check", { project: t.project, feature: t.feature, text: t.text, done: true }, "checked in plan.md"); }
async function ticketMove(i, delta) {
  const t = TK[i];
  if (delta < 0 && !t.prev) return;
  if (delta > 0 && t.isLast) return;
  const before = delta < 0 ? t.prev : t.isSecondLast ? null : t.after;
  await act("/api/plan/move", { project: t.project, feature: t.feature, text: t.text, before });
}

// ---------- drag & drop ----------
function dragStart(ev, what) {
  dragging = what;
  ev.dataTransfer.effectAllowed = "move";
  ev.dataTransfer.setData("text/plain", "cockpit");
  if (what.kind === "tile") ev.currentTarget.classList.add("dragging");
  ev.stopPropagation();
}
function dragEnd() { dragging = null; document.querySelectorAll(".drag-over,.drop").forEach((el) => el.classList.remove("drag-over", "drop")); }
function dragOver(ev, kind, i) {
  if (!dragging || dragging.kind !== kind) return;
  if (kind === "ticket") { const a = TK[dragging.i], b = TK[i]; if (!b || a.project !== b.project || a.feature !== b.feature) return; }
  ev.preventDefault();
  ev.stopPropagation();
  ev.currentTarget.classList.add(ev.currentTarget.classList.contains("tiles") ? "drop" : "drag-over");
}
async function dropQueue(ev, i) {
  ev.preventDefault(); ev.stopPropagation();
  const from = dragging?.i;
  dragEnd();
  if (from === undefined || from === i) return;
  await act("/api/portfolio/queue", { op: "move", ...qref(from), index: i });
}
async function dropTicket(ev, i) {
  ev.preventDefault(); ev.stopPropagation();
  const a = TK[dragging?.i], b = TK[i];
  dragEnd();
  if (!a || !b || a === b) return;
  await act("/api/plan/move", { project: a.project, feature: a.feature, text: a.text, before: b.text });
}
async function dropTile(ev, targetName) {
  ev.preventDefault(); ev.stopPropagation();
  const name = dragging?.name;
  dragEnd();
  if (!name || name === targetName) return;
  const zone = ev.currentTarget.closest(".tiles");
  const bucket = zone?.dataset.bucket || null;
  const p = byName(name);
  let index;
  if (targetName) {
    const t = byName(targetName);
    index = t.bucketIndex ?? undefined;
    if (index !== undefined && p.bucket === bucket && p.bucketIndex < index) index -= 1;
  }
  await act("/api/portfolio/bucket", { project: name, bucket, index }, bucket ? `${name} → ${bucket}` : `${name} unranked`);
}

// ---------- other sub-folders (discovery) ----------
function subfoldersHtml(firstRun) {
  if (!DISC || !DISC.length) return firstRun ? "" : `<details class="card"><summary>Other sub-folders<span class="hint">add a folder to scan</span></summary>${addRootHtml()}</details>`;
  const total = DISC.reduce((n, r) => n + r.folders.filter((f) => !f.ignored).length, 0);
  const open = subfOpen ?? firstRun;
  const roots = DISC.map((r) => {
    const live = r.folders.filter((f) => !f.ignored), ign = r.folders.filter((f) => f.ignored);
    const row = (f) => `<div class="fold"><span class="fnm">${esc(f.name)}</span><span class="kindtag">${f.kind}</span><span class="ftag" title="${esc(f.path)}">${esc(f.tagline || (f.kind === "folder" ? "contains sub-folders" : ""))}</span>
      ${f.ignored ? `<button class="mini" onclick="ignorePath(${jsArg(f.path)}, false)">un-ignore</button>`
        : (f.kind === "folder" ? `<button class="mini" onclick="addRoot(${jsArg(f.path)})" title="list its sub-folders here too">scan inside</button>` : `<button class="mini" onclick="addProject(${jsArg(f.path)})">add</button>`) + `<button class="mini ghost" onclick="ignorePath(${jsArg(f.path)}, true)">ignore</button>`}</div>`;
    return `<div class="root"><div class="rp"><span class="mono">${esc(r.root.replace(/^\/Users\/[^/]+/, "~"))}</span>
        ${r.explicit ? `<button class="link note" onclick="removeRoot(${jsArg(r.root)})">stop scanning</button>` : `<span class="note">(holds registered projects)</span>`}</div>
      ${live.map(row).join("") || `<div class="note">everything here is registered or ignored</div>`}
      ${ign.length ? `<details><summary class="note" style="cursor:pointer">ignored (${ign.length})</summary>${ign.map(row).join("")}</details>` : ""}</div>`;
  }).join("");
  return `<details class="card" id="subf" ${open ? "open" : ""} ontoggle="subfOpen=this.open"><summary>Other sub-folders<span class="hint">${total} not registered · nothing is added until you pick</span></summary>${roots}${addRootHtml()}</details>`;
}
const addRootHtml = () => `<div class="addrow"><input class="txt" id="rootin" placeholder="another folder of projects, e.g. ~/code" style="flex:1;max-width:420px" onkeydown="if(event.key==='Enter')addRoot()"><button class="btn" onclick="addRoot()">scan folder</button></div>`;
async function addRoot(path) {
  const el = document.getElementById("rootin");
  const p = path || el?.value.trim();
  if (!p) return;
  if (el) el.value = "";
  subfOpen = true;
  await act("/api/roots", { path: p }, "scanning " + p);
}
async function removeRoot(path) { await act("/api/roots", { path, remove: true }, "stopped scanning " + path); }
async function ignorePath(path, ignore) { await act("/api/ignore", { path, ignore }, ignore ? "ignored" : "un-ignored"); }
async function addProject(path) {
  const d = await act("/api/add", { path }, "added " + path.split("/").pop());
  if (d?.onboardHint) showModal("Added — onboard it with ai-foundation?", `<p>Optional: this repo has no <code>.ai/foundation-version.md</code>. Onboarding installs shared rules and skills additively:</p><pre>${esc(d.onboardHint)}</pre><div class="actions"><button class="btn" onclick="copy(${esc(JSON.stringify(d.onboardHint))})">copy command</button></div>`);
}
function openAddPath() {
  showModal("Add a project", `<label class="f">Path to the project folder</label><input class="txt" id="addpath" placeholder="~/projects/my-app" onkeydown="if(event.key==='Enter')submitAddPath()">
    <div class="actions"><button class="btn primary" onclick="submitAddPath()">add</button><span class="note">Or open “Other sub-folders” below to pick from folders next to your projects.</span></div>`);
  setTimeout(() => document.getElementById("addpath")?.focus(), 30);
}
async function submitAddPath() { const v = document.getElementById("addpath").value.trim(); if (!v) return; closeModal(); await addProject(v); }

// ---------- welcome, recent, next steps ----------
function welcomeHtml() {
  return `<div class="card welcome"><h2>Welcome to cockpit</h2>
    <p>One screen for all your projects: what needs you, what's next, what's running. Point it at the folder that holds your projects — it lists the sub-folders, and nothing is added until you pick.</p>
    <div class="addrow"><input class="txt" id="rootin" placeholder="~/projects" style="width:min(360px,100%)" onkeydown="if(event.key==='Enter')addRoot()"><button class="btn primary" onclick="addRoot()">Scan this folder</button></div>
    <p class="note">Or <button class="link" onclick="openAddPath()">add a single project by path</button>. Just looking? <code>cockpit demo</code> opens a sandbox with sample projects and touches nothing of yours.</p></div>`;
}
function recentHtml() {
  const rows = D.recent.map((c) => {
    const p = byName(c.project);
    return `<div class="row"><span class="pn"><span class="pdot" style="background:${esc(p?.color || "var(--ink-3)")}"></span>${esc(c.project)}</span><span class="t" title="${esc(c.subject)}">${esc(c.subject)}</span><span class="mut" style="flex:none;font-size:12px">${esc(c.age)}</span></div>`;
  }).join("");
  return `<div class="card"><h2>Recently shipped<span class="hint">commits, last 7 days</span></h2>${rows || `<div class="mut">No commits this week.</div>`}</div>`;
}
function stepsHtml() {
  const dismissed = new Set(store.get("cockpit.dismissed", []));
  const P = D.projects;
  const all = [
    !D.setup.portfolio && { id: "portfolio", text: "Set priorities: drag a tile into <b>Now</b> (at most 3). That starts portfolio.md, the one list of what matters most across projects." },
    P.some((p) => !p.about?.title) && { id: "about", text: `Describe your projects: ${P.filter((p) => !p.about?.title).length} tile(s) have no tagline yet — click “+ add a one-line description”. It's saved as ABOUT.md in the project.` },
    !D.setup.hooks && { id: "hooks", text: "Exact agent status: <code>cockpit hooks --install</code> makes “Claude is waiting” precise instead of guessed from transcripts.", cmd: "cockpit hooks --install" },
    P.length >= 3 && { id: "ideas", text: "Capture ideas without committing to them: <b>Ideate</b> on a tile keeps them in plan.md under ## Ideas; <b>Plan</b> turns one into tickets." },
    P.length >= 3 && { id: "phone", text: "Glance from your phone: the dashboard can run over Tailscale with token auth — <a href=\"https://github.com/earlyadopter/project-cockpit/blob/main/docs/remote-access.md\" target=\"_blank\">setup guide ↗</a>" },
  ].filter(Boolean).filter((s) => !dismissed.has(s.id)).slice(0, 2);
  if (!all.length) return `<div></div>`;
  return `<div class="card steps"><h2>Next steps<span class="hint">one or two at a time</span></h2>${all.map((s) => `<div class="row"><span class="t">${s.text}</span>${s.cmd ? `<button class="mini" onclick="copy(${jsArg(s.cmd)})">copy</button>` : ""}<button class="mini ghost" title="dismiss" onclick="dismissStep('${s.id}')">✕</button></div>`).join("")}</div>`;
}
function dismissStep(id) { const d = store.get("cockpit.dismissed", []); d.push(id); store.set("cockpit.dismissed", d); render(); }

// ---------- modals: ABOUT, answer, Ideate, Plan ----------
function showModal(title, html) {
  document.getElementById("mtitle").textContent = title;
  document.getElementById("mbody").innerHTML = html;
  document.getElementById("modal").classList.add("open");
}
function closeModal() { document.getElementById("modal").classList.remove("open"); }

async function editAbout(name) {
  const r = await fetch("/api/about/draft?project=" + encodeURIComponent(name));
  const d = await r.json();
  const a = d.about, dr = d.draft;
  const p = byName(name);
  window._aboutFor = name;
  showModal(`${name} — description`, `<label class="f">Tagline — a short phrase for headings</label><input class="txt" id="ab-title" maxlength="120" value="${esc(a?.title || dr.title)}">
    <label class="f">Description — a paragraph for places with room</label><textarea class="txt" id="ab-desc">${esc(a ? a.description : dr.description)}</textarea>
    <div class="actions"><button class="btn primary" onclick="saveAbout()">save</button>
    <span class="note">${a ? `Saved to <code>${esc(a.path.replace(/^\/Users\/[^/]+/, "~"))}</code> — editing that file directly works too.` : `No ABOUT.md yet — drafted from ${esc(dr.source)}. Saving creates <code>${esc(p.root.replace(/^\/Users\/[^/]+/, "~"))}/ABOUT.md</code>.`}</span></div>`);
}
async function saveAbout() {
  const r = await post("/api/about", { project: window._aboutFor, title: document.getElementById("ab-title").value, description: document.getElementById("ab-desc").value });
  if (!r.ok) { toast(r.d.error || "failed", true); return; }
  closeModal(); toast("ABOUT.md saved"); refresh(true);
}

function answerQ(i) {
  const it = IT[i];
  window._ans = it;
  showModal(`${it.project} — Direction question`, `<p>${esc(it.text)}</p><label class="f">Your answer</label><input class="txt" id="ans-in" placeholder="the decision, one line" onkeydown="if(event.key==='Enter')submitAnswer()">
    <div class="actions"><button class="btn primary" onclick="submitAnswer()">decide</button><a class="note" href="/project#${encodeURIComponent(it.project)}">context + generated options on the project page ›</a></div>
    <p class="note">Deciding checks the question in plan.md with your answer and queues a ticket under “Implementation queue”. Nothing runs.</p>`);
  setTimeout(() => document.getElementById("ans-in")?.focus(), 30);
}
async function submitAnswer() {
  const answer = document.getElementById("ans-in").value.trim();
  if (!answer) return;
  const r = await post("/api/plan/answer", { project: window._ans.project, question: window._ans.text, answer });
  if (!r.ok) { toast(r.d.error || "failed", true); return; }
  closeModal(); toast("decided — ticket queued in plan.md"); refresh(true);
}

async function workTicket(i) {
  const it = IT[i];
  await startWork(it.project, it.feature, it.text);
}
async function workTicketRow(i) { const t = TK[i]; await startWork(t.project, t.feature, t.text); }
async function startWork(project, feature, text) {
  if (!confirm(`Start implementing this ticket?\n\n  ${text}\n  (${project} · ${feature})\n\nOpens an attended Claude Code session in ${project}'s tmux 'impl' window, briefed with the ticket. It checks the box when done and never pushes.`)) return;
  const r = await post("/api/plan/work", { project, feature, ticket: text });
  if (!r.ok) { toast(r.d.error || "failed", true); return; }
  toast(`working on it — tmux window "impl" in ${project}`);
  refresh(true);
}
async function jump(project) {
  const r = await post("/api/focus", { project });
  if (!r.ok) toast(r.d.error || "failed", true);
  else if (!r.d.attached) toast(`tmux window "${r.d.window}" selected — attach with: cockpit go ${project}`);
}
async function terminal(name) {
  const r = await post("/api/terminal", { project: name });
  if (r.ok && r.d.ok) { toast(r.d.focused ? `focused ${name} · ${r.d.focused}` : `opened ${name} in iTerm2`); return; }
  if (r.d.copy) showModal(`${name} — terminal`, `<p>Couldn't open iTerm2 from here. In any terminal:</p><pre>${esc(r.d.copy)}</pre><div class="actions"><button class="btn" onclick="copy(${jsArg(r.d.copy)})">copy</button></div>`);
  else toast(r.d.error || "failed", true);
}
async function session(name, mode) {
  if (!confirm(`Open a Claude Code session in ${name}'s tmux (window "${mode}") to ${mode === "plan" ? "plan" : "brainstorm"} with you?\n\nIt is attended — you talk to it there. It edits plan.md (${mode === "plan" ? "a feature with tickets" : "## Ideas"}) and does not implement anything.`)) return;
  const r = await post("/api/session", { project: name, mode, confirmed: true });
  if (!r.ok) { toast(r.d.error || "failed", true); return; }
  closeModal();
  toast(`session started — tmux window "${mode}" in ${name}`);
  terminal(name);
}

function ideate(name) {
  const p = byName(name);
  window._for = name;
  showModal(`${name} — Ideate`, `<div class="tabs"><button class="on" id="tb-w" onclick="tab('w')">Write or paste</button><button id="tb-c" onclick="tab('c')">Ask Claude</button></div>
    <div id="tab-w"><textarea class="txt" id="ideas-in" placeholder="One idea per line. Pasted bullet lists work — markers are stripped."></textarea>
      <div class="actions"><button class="btn primary" onclick="saveIdeas()">add to ## Ideas</button><span class="note">Ideas are plain bullets in plan.md — not tickets, not commitments.</span></div></div>
    <div id="tab-c" hidden><input class="txt" id="steer" placeholder="optional focus — e.g. “growth”, “cut scope”, “what would make me use it daily”">
      <div class="actions"><button class="btn" id="sugbtn" onclick="suggest()">✨ suggest ideas</button><span class="note">reads plan.md, ABOUT.md and the README · 15–60 s · nothing is written until you pick</span></div><div id="sugs"></div></div>
    <label class="f">Already in ## Ideas (${p.ideas.length})</label>${p.ideas.length ? p.ideas.map((i) => `<div class="row"><span class="t multi">${esc(i)}</span></div>`).join("") : `<div class="note">none yet</div>`}
    <div class="actions"><button class="link" onclick="session(${jsArg(name)},'ideate')">or brainstorm in a live Claude session ↗</button></div>`);
  setTimeout(() => document.getElementById("ideas-in")?.focus(), 30);
}
function tab(t) {
  for (const k of ["w", "c"]) { document.getElementById("tab-" + k).hidden = k !== t; document.getElementById("tb-" + k).classList.toggle("on", k === t); }
}
async function saveIdeas() {
  const ideas = document.getElementById("ideas-in").value.split("\n").filter((l) => l.trim());
  if (!ideas.length) return;
  const r = await post("/api/ideas/add", { project: window._for, ideas });
  if (!r.ok) { toast(r.d.error || "failed", true); return; }
  toast(`${r.d.added} idea(s) added to plan.md`);
  await refresh(true);
  ideate(window._for);
}
async function suggest() {
  const btn = document.getElementById("sugbtn");
  btn.disabled = true; btn.textContent = "thinking…";
  const r = await post("/api/ideas/suggest", { project: window._for, steer: document.getElementById("steer").value });
  btn.disabled = false; btn.textContent = "✨ suggest again";
  const el = document.getElementById("sugs");
  if (!el) return;
  if (!r.ok) { el.innerHTML = `<p class="note" style="color:var(--bad)">${esc(r.d.error || "failed")}</p>`; return; }
  if (!r.d.ideas) { el.innerHTML = `<pre>${esc(r.d.raw || "")}</pre>`; return; }
  window._sugs = r.d.ideas;
  el.innerHTML = r.d.ideas.map((i, k) => `<label class="row"><input type="checkbox" class="cb" id="sg-${k}"><span class="t multi">${esc(i)}</span></label>`).join("") +
    `<div class="actions"><button class="btn primary" onclick="saveSuggested()">add selected to ## Ideas</button></div>`;
}
async function saveSuggested() {
  const ideas = (window._sugs || []).filter((_, k) => document.getElementById("sg-" + k)?.checked);
  if (!ideas.length) { toast("tick at least one", true); return; }
  const r = await post("/api/ideas/add", { project: window._for, ideas });
  if (!r.ok) { toast(r.d.error || "failed", true); return; }
  toast(`${r.d.added} idea(s) added to plan.md`);
  await refresh(true);
  ideate(window._for);
  tab("c");
}

function planModal(name) {
  const p = byName(name);
  window._for = name;
  showModal(`${name} — Plan`, `<label class="f">Start from an idea</label><select class="txt" id="pl-idea" style="width:100%" onchange="document.getElementById('pl-goal').value=this.value"><option value="">— something new —</option>${p.ideas.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join("")}</select>
    <label class="f">Idea or goal</label><input class="txt" id="pl-goal" placeholder="what should exist when this is done?">
    <div class="actions"><button class="btn" id="draftbtn" onclick="draftFeature()">✨ draft feature + tickets with Claude</button><span class="note">15–60 s · you edit before anything is written</span></div>
    <label class="f">Feature</label><input class="txt" id="pl-feature" list="pl-feats" placeholder="a short name — or an existing feature to add tickets to"><datalist id="pl-feats">${p.features.map((f) => `<option value="${esc(f)}">`).join("")}</datalist>
    <label class="f">Tickets — one per line, most important first</label><textarea class="txt" id="pl-tickets" placeholder="small, checkable steps"></textarea>
    <div class="actions"><button class="btn primary" onclick="writeFeature()">write to plan.md</button><button class="link" onclick="session(${jsArg(name)},'plan')">or plan in a live Claude session ↗</button></div>`);
}
async function draftFeature() {
  const idea = document.getElementById("pl-goal").value.trim();
  if (!idea) { toast("write the idea or goal first", true); return; }
  const btn = document.getElementById("draftbtn");
  btn.disabled = true; btn.textContent = "drafting…";
  const r = await post("/api/plan/draft", { project: window._for, idea });
  btn.disabled = false; btn.textContent = "✨ draft again";
  if (!r.ok) { toast(r.d.error || "failed", true); return; }
  if (!r.d.feature) { toast("Claude didn't return a usable draft — see the raw answer in the tickets box", true); document.getElementById("pl-tickets").value = r.d.raw || ""; return; }
  document.getElementById("pl-feature").value = r.d.feature;
  document.getElementById("pl-tickets").value = r.d.tickets.join("\n");
}
async function writeFeature() {
  const feature = document.getElementById("pl-feature").value.trim();
  const tickets = document.getElementById("pl-tickets").value.split("\n").filter((l) => l.trim());
  const idea = document.getElementById("pl-idea").value || undefined;
  if (!feature || !tickets.length) { toast("a feature name and at least one ticket", true); return; }
  const r = await post("/api/plan/feature", { project: window._for, feature, tickets, idea });
  if (!r.ok) { toast(r.d.error || "failed", true); return; }
  closeModal();
  toast(`“${feature}” written to plan.md (${tickets.length} tickets)`);
  expanded.add(window._for);
  refresh(true);
}

setInterval(() => {
  const el = document.getElementById("freshness");
  const s = Math.round((Date.now() - lastRefreshAt) / 1000);
  el.textContent = s <= 2 ? "updated just now" : `updated ${s}s ago`;
  el.style.color = s > 25 ? "var(--warn-ink)" : "";
}, 1000);
refresh(true);
setInterval(refresh, 10000);
