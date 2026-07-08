// Shared state layer for the cockpit CLI and dashboard.
// The filesystem is the source of truth — everything here recomputes live
// from git/tmux/lsof on every call; nothing is cached.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";

export const COCKPIT_DIR = join(homedir(), ".project-cockpit");
export const REGISTRY_FILE = join(COCKPIT_DIR, "registry.yml");
export const AUDIT_FILE = join(COCKPIT_DIR, "audit.log");
export const TMUX_WINDOWS = ["dev", "agent", "shell"];

export type Tier = "safe" | "confirm" | "manual";
export interface ActionDef { cmd: string; tier?: Tier; window?: string }
export interface Service { name?: string; kind?: string; url?: string; port?: number }
export interface Config {
  name?: string; focus?: string; repo?: string; notes?: string; changelog?: string; plan?: string;
  services?: Service[]; env_files?: string[]; actions?: Record<string, ActionDef>;
}
export interface Project { root: string; name: string; cfg: Config; hasConfig: boolean }

// ---------- shell ----------
export function sh(cmd: string, args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: ((r.stdout ?? "") as string).trim() };
}

const execFileP = promisify(execFile);
export async function shA(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await execFileP(cmd, args, { encoding: "utf8" });
    return { ok: true, out: r.stdout.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

// ---------- registry & config ----------
export function loadRegistry(): string[] {
  if (!existsSync(REGISTRY_FILE)) return [];
  const doc = yamlLoad(readFileSync(REGISTRY_FILE, "utf8")) as { projects?: string[] } | null;
  return doc?.projects ?? [];
}

export function saveRegistry(paths: string[]): void {
  mkdirSync(COCKPIT_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, yamlDump({ projects: paths }));
}

export function loadProject(root: string): Project {
  const cfgPath = join(root, ".project-cockpit.yml");
  let cfg: Config = {};
  let hasConfig = false;
  if (existsSync(cfgPath)) {
    try {
      cfg = (yamlLoad(readFileSync(cfgPath, "utf8")) as Config) ?? {};
      hasConfig = true;
    } catch (e) {
      console.error(`warning: could not parse ${cfgPath}: ${e}`);
    }
  }
  return { root, name: cfg.name || basename(root), cfg, hasConfig };
}

export function allProjects(): Project[] {
  return loadRegistry().map(loadProject);
}

// ---------- live state ----------
export interface GitState {
  isRepo: boolean; branch: string; dirty: string[];
  ahead: number | null; behind: number | null; hasUpstream: boolean;
  lastCommit: string; lastCommitAge: string; hasRemote: boolean;
}

export async function gitState(root: string): Promise<GitState> {
  const s: GitState = {
    isRepo: false, branch: "", dirty: [], ahead: null, behind: null,
    hasUpstream: false, lastCommit: "", lastCommitAge: "", hasRemote: false,
  };
  if (!(await shA("git", ["-C", root, "rev-parse", "--git-dir"])).ok) return s;
  s.isRepo = true;
  const [branch, porcelain, remote, ab, log] = await Promise.all([
    shA("git", ["-C", root, "branch", "--show-current"]),
    shA("git", ["-C", root, "status", "--porcelain"]),
    shA("git", ["-C", root, "remote"]),
    shA("git", ["-C", root, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    shA("git", ["-C", root, "log", "-1", "--format=%s%n%cr"]),
  ]);
  s.branch = branch.out;
  s.dirty = porcelain.out ? porcelain.out.split("\n") : [];
  s.hasRemote = remote.out !== "";
  if (ab.ok) {
    s.hasUpstream = true;
    const [behind, ahead] = ab.out.split(/\s+/).map(Number);
    s.behind = behind;
    s.ahead = ahead;
  }
  if (log.ok && log.out) [s.lastCommit, s.lastCommitAge] = log.out.split("\n");
  return s;
}

export async function tmuxSessionAlive(name: string): Promise<boolean> {
  return (await shA("tmux", ["has-session", "-t", `=${name}`])).ok;
}

export async function tmuxWindows(name: string): Promise<string[]> {
  const r = await shA("tmux", ["list-windows", "-t", `=${name}`, "-F", "#{window_name}"]);
  return r.ok && r.out ? r.out.split("\n") : [];
}

export async function portListening(port: number): Promise<boolean> {
  return (await shA("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).ok;
}

export function localService(p: Project): Service | undefined {
  return p.cfg.services?.find((s) => s.kind === "local");
}

export function attentionItems(p: Project, git: GitState, agent?: AgentInfo, plan?: Plan | null): string[] {
  const items: string[] = [];
  if (agent?.state === "waiting") items.push("agent waiting for you");
  if (plan) {
    const q = plan.direction.filter((d) => !d.done).length;
    if (q > 0) items.push(`${q} open question${q > 1 ? "s" : ""}`);
  }
  if (git.dirty.length > 0) items.push(`${git.dirty.length} uncommitted`);
  if (git.ahead) items.push(`${git.ahead} unpushed`);
  if (git.behind) items.push(`${git.behind} behind remote`);
  if (git.isRepo && git.hasRemote && !git.hasUpstream && git.lastCommit) items.push("no upstream set");
  if (!p.hasConfig) items.push("no .project-cockpit.yml");
  return items;
}

// Date of the tip of origin's default branch — the "last push to PROD" proxy
// for push-to-deploy projects. Accurate as of the last fetch.
export async function lastPush(root: string): Promise<{ ref: string; date: string; age: string } | null> {
  let ref = (await shA("git", ["-C", root, "rev-parse", "--abbrev-ref", "origin/HEAD"])).out;
  if (!ref) {
    for (const candidate of ["origin/main", "origin/master"]) {
      if ((await shA("git", ["-C", root, "rev-parse", "--verify", candidate])).ok) { ref = candidate; break; }
    }
  }
  if (!ref) return null;
  const r = await shA("git", ["-C", root, "log", "-1", "--format=%cI%n%cr", ref]);
  if (!r.ok || !r.out) return null;
  const [date, age] = r.out.split("\n");
  return { ref, date, age };
}

export async function recentCommits(root: string, n = 10): Promise<{ hash: string; subject: string; age: string }[]> {
  const r = await shA("git", ["-C", root, "log", `-${n}`, "--format=%h%x09%s%x09%cr"]);
  if (!r.ok || !r.out) return [];
  return r.out.split("\n").map((line) => {
    const [hash, subject, age] = line.split("\t");
    return { hash, subject, age };
  });
}

const CHANGELOG_CANDIDATES = ["CHANGELOG.md", "docs/CHANGELOG.md", "docs/changelog.md", "changelog.md"];

export function readChangelog(p: Project, maxLines = 80): { path: string; text: string } | null {
  const candidates = p.cfg.changelog ? [p.cfg.changelog, ...CHANGELOG_CANDIDATES] : CHANGELOG_CANDIDATES;
  for (const rel of candidates) {
    const full = join(p.root, rel);
    if (existsSync(full)) {
      const lines = readFileSync(full, "utf8").split("\n");
      const text = lines.slice(0, maxLines).join("\n") + (lines.length > maxLines ? "\n…" : "");
      return { path: rel, text };
    }
  }
  return null;
}

// Unregistered git repos in the parent folders of registered projects —
// one-click "add project" candidates for the dashboard.
export function discoverCandidates(): { path: string; name: string; hasConfig: boolean }[] {
  const registered = new Set(loadRegistry().map((p) => p.replace(/\/$/, "")));
  const parents = new Set([...registered].map((p) => join(p, "..")));
  const found: { path: string; name: string; hasConfig: boolean }[] = [];
  for (const parent of parents) {
    let entries: string[] = [];
    try { entries = readdirSync(parent); } catch { continue; }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const full = join(parent, e);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch { continue; }
      const real = full.replace(/\/$/, "");
      if (registered.has(real)) continue;
      if (!existsSync(join(real, ".git")) && !existsSync(join(real, ".project-cockpit.yml"))) continue;
      found.push({ path: real, name: basename(real), hasConfig: existsSync(join(real, ".project-cockpit.yml")) });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- agent visibility (Phase 4) ----------
// Claude Code leaves two observable traces: a `claude` process whose cwd is the
// project root, and per-project transcript files under ~/.claude/projects/
// (path encoded with non-alphanumerics as dashes) whose mtime tracks activity.
// Heuristic, best-effort, never load-bearing.

export type AgentStateKind = "working" | "waiting" | "idle" | "none";
export interface AgentInfo {
  procs: number;
  state: AgentStateKind;
  detail: string;
  ageSec: number | null; // seconds since last transcript write
}

export async function claudeCwds(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const ps = await shA("ps", ["-axo", "pid=,comm="]);
  const pids = ps.out.split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && /(^|\/)claude$/.test(m[2]))
    .map((m) => m[1]);
  if (!pids.length) return map;
  const r = await shA("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]);
  for (const line of r.out.split("\n")) {
    if (line.startsWith("n")) {
      const path = line.slice(1).replace(/\/$/, "");
      map.set(path, (map.get(path) ?? 0) + 1);
    }
  }
  return map;
}

export function transcriptDir(root: string): string {
  return join(homedir(), ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
}

function readLastBytes(file: string, bytes = 65536): string {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// Scan a transcript tail backwards for the last user/assistant message and
// report whether the turn looks finished (assistant text with no tool_use).
function lastTurnFinished(file: string): boolean | null {
  try {
    const lines = readLastBytes(file).split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let e: any;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e?.type !== "assistant" && e?.type !== "user") continue;
      if (e.type === "user") return false; // tool result / user msg mid-processing
      const content = e.message?.content;
      if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_use")) return false;
      return true; // assistant text/thinking only — turn complete
    }
  } catch { /* unreadable — unknown */ }
  return null;
}

export async function agentState(p: Project, cwds: Map<string, number>): Promise<AgentInfo> {
  const procs = cwds.get(p.root.replace(/\/$/, "")) ?? 0;
  const dir = transcriptDir(p.root);
  let newest: { file: string; mtime: number } | null = null;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(dir, f);
      const mt = statSync(full).mtimeMs;
      if (!newest || mt > newest.mtime) newest = { file: full, mtime: mt };
    }
  }
  const ageSec = newest ? Math.max(0, Math.round((Date.now() - newest.mtime) / 1000)) : null;

  if (procs === 0) return { procs, state: "none", detail: "no Claude Code process", ageSec };
  if (ageSec === null) return { procs, state: "idle", detail: "process running, no transcript found", ageSec };
  if (ageSec > 30 * 60) return { procs, state: "idle", detail: "no activity for 30+ min", ageSec };
  if (ageSec < 45) return { procs, state: "working", detail: "actively writing", ageSec };
  const finished = lastTurnFinished(newest!.file);
  if (finished === false) return { procs, state: "waiting", detail: "stalled mid-turn — possibly waiting for permission", ageSec };
  return { procs, state: "waiting", detail: "turn finished — waiting for your input", ageSec };
}

export function humanAge(sec: number | null): string {
  if (sec === null) return "";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

// ---------- actions & opening (shared by CLI and dashboard) ----------
export async function ensureSession(p: Project): Promise<boolean> {
  if (await tmuxSessionAlive(p.name)) return false;
  const first = TMUX_WINDOWS[0];
  if (!sh("tmux", ["new-session", "-d", "-s", p.name, "-c", p.root, "-n", first]).ok)
    throw new Error(`failed to create tmux session "${p.name}"`);
  for (const w of TMUX_WINDOWS.slice(1))
    sh("tmux", ["new-window", "-d", "-t", `=${p.name}`, "-c", p.root, "-n", w]);
  sh("tmux", ["select-window", "-t", `=${p.name}:${first}`]);
  return true;
}

export const OPEN_TARGETS = ["cursor", "obsidian", "finder", "github", "deploy", "dev"] as const;

export function openTarget(p: Project, target: string): { ok: boolean; result?: string; error?: string } {
  const svcUrl = (kinds: string[]) => p.cfg.services?.find((s) => s.kind && kinds.includes(s.kind))?.url;
  switch (target) {
    case "cursor": {
      const r = sh("cursor", [p.root]);
      if (!r.ok) sh("open", ["-a", "Cursor", p.root]);
      return { ok: true, result: p.root };
    }
    case "obsidian":
      if (!p.cfg.notes) return { ok: false, error: `no notes: configured in ${p.name}/.project-cockpit.yml` };
      sh("open", [p.cfg.notes]);
      return { ok: true, result: p.cfg.notes };
    case "finder":
      sh("open", [p.root]);
      return { ok: true, result: p.root };
    case "github":
      if (!p.cfg.repo) return { ok: false, error: `no repo: configured for ${p.name}` };
      sh("open", [p.cfg.repo]);
      return { ok: true, result: p.cfg.repo };
    case "deploy": {
      const url = svcUrl(["vercel", "render"]);
      if (!url) return { ok: false, error: `no vercel/render service configured for ${p.name}` };
      sh("open", [url]);
      return { ok: true, result: url };
    }
    case "dev": {
      const url = svcUrl(["local"]);
      if (!url) return { ok: false, error: `no local service configured for ${p.name}` };
      sh("open", [url]);
      return { ok: true, result: url };
    }
    default:
      return { ok: false, error: `unknown target "${target}" — one of: ${OPEN_TARGETS.join(", ")}` };
  }
}

// Run a non-window action, capturing output (dashboard path; the CLI streams instead).
export function runInline(p: Project, cmd: string, timeoutMs = 300_000): { status: number | null; output: string } {
  const r = spawnSync("bash", ["-lc", cmd], {
    cwd: p.root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
  });
  let output = ((r.stdout ?? "") + (r.stderr ? "\n" + r.stderr : "")).trim();
  const lines = output.split("\n");
  if (lines.length > 200) output = "…\n" + lines.slice(-200).join("\n");
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") output += "\n[cockpit: timed out]";
  return { status: r.status, output };
}

export async function sendToWindow(p: Project, window: string, cmd: string): Promise<void> {
  await ensureSession(p);
  sh("tmux", ["send-keys", "-t", `=${p.name}:${window}`, cmd, "Enter"]);
}

export function readAudit(maxLines = 200): string {
  if (!existsSync(AUDIT_FILE)) return "";
  const lines = readFileSync(AUDIT_FILE, "utf8").trimEnd().split("\n");
  return lines.slice(-maxLines).join("\n");
}

// ---------- plan.md (features / tickets / direction) ----------
// Convention: `## Direction` holds checkbox questions (checked = answered);
// `## Features` holds `### <feature>` blocks with checkbox tickets.
// The file is the source of truth; strike-through/sorting are rendering rules only.

export interface PlanItem { done: boolean; text: string }
export interface PlanFeature { name: string; tickets: PlanItem[] }
export interface Plan { path: string; direction: PlanItem[]; features: PlanFeature[] }

const PLAN_CANDIDATES = ["plan.md", "PLAN.md", "planning/plan.md"];

export function readPlan(p: Project): Plan | null {
  const candidates = p.cfg.plan ? [p.cfg.plan, ...PLAN_CANDIDATES] : PLAN_CANDIDATES;
  for (const rel of candidates) {
    const full = join(p.root, rel);
    if (!existsSync(full)) continue;
    // Tolerant parsing: `## Direction` checkboxes are questions; ### blocks
    // anywhere are features; checkboxes sitting directly under any other H2
    // (e.g. "## Ready to start now") form an implicit feature named after it.
    const plan: Plan = { path: rel, direction: [], features: [] };
    let section: "direction" | "other" = "other";
    let sectionTitle = "";
    let feature: PlanFeature | null = null;
    let implicit: PlanFeature | null = null;
    for (const line of readFileSync(full, "utf8").split("\n")) {
      const h2 = line.match(/^##(?!#)\s+(.+)/);
      if (h2) {
        sectionTitle = h2[1].trim();
        section = /^direction/i.test(sectionTitle) ? "direction" : "other";
        feature = null;
        implicit = null;
        continue;
      }
      const h3 = line.match(/^###\s+(.+)/);
      if (h3) {
        feature = { name: h3[1].trim(), tickets: [] };
        plan.features.push(feature);
        continue;
      }
      const cb = line.match(/^\s*[-*]\s*\[( |x|X)\]\s+(.+)/);
      if (!cb) continue;
      const item = { done: cb[1].toLowerCase() === "x", text: cb[2].trim() };
      if (section === "direction") { plan.direction.push(item); continue; }
      if (feature) { feature.tickets.push(item); continue; }
      if (!implicit) {
        implicit = { name: sectionTitle && !/^features$/i.test(sectionTitle) ? sectionTitle : "Tickets", tickets: [] };
        plan.features.push(implicit);
      }
      implicit.tickets.push(item);
    }
    return plan;
  }
  return null;
}

// Answer an open Direction question: check its box and append the decision,
// then queue the answer as a ticket under "### Implementation queue".
// Single-line, surgical edits — the rest of the file is untouched.
export function answerDirection(p: Project, question: string, answer: string): { ok: boolean; error?: string } {
  const plan = readPlan(p);
  if (!plan) return { ok: false, error: "no plan.md in this project" };
  const full = join(p.root, plan.path);
  const lines = readFileSync(full, "utf8").split("\n");
  const date = new Date().toISOString().slice(0, 10);

  const qNorm = question.trim();
  const idx = lines.findIndex((l) => {
    const m = l.match(/^\s*[-*]\s*\[ \]\s+(.+)/);
    return m && m[1].trim() === qNorm;
  });
  if (idx === -1) return { ok: false, error: "question not found (file changed since last refresh?)" };
  lines[idx] = lines[idx].replace(/\[ \]\s+.*/, `[x] ${qNorm} → ${answer.trim()} (decided ${date})`);

  const ticket = `- [ ] ${answer.trim()} — from: ${qNorm.replace(/\?+\s*$/, "")}?`;
  const queueIdx = lines.findIndex((l) => /^###\s+Implementation queue\s*$/i.test(l));
  if (queueIdx !== -1) {
    // insert after the last ticket of the queue block
    let end = queueIdx + 1;
    while (end < lines.length && !/^##/.test(lines[end])) end++;
    while (end > queueIdx + 1 && lines[end - 1].trim() === "") end--;
    lines.splice(end, 0, ticket);
  } else {
    const featIdx = lines.findIndex((l) => /^##(?!#)\s+Features/i.test(l));
    if (featIdx !== -1) {
      lines.splice(featIdx + 1, 0, "", "### Implementation queue", "", ticket);
    } else {
      lines.push("", "## Features", "", "### Implementation queue", "", ticket);
    }
  }
  writeFileSync(full, lines.join("\n"));
  return { ok: true };
}

// Resolve "planning/NN" style references in a direction question to real files.
export function findPlanningRefs(p: Project, text: string): { path: string; excerpt: string }[] {
  const refs: { path: string; excerpt: string }[] = [];
  const seen = new Set<string>();
  const dirs = [join(p.root, "planning")];
  try {
    for (const e of readdirSync(p.root)) {
      const d = join(p.root, e, "planning");
      if (!e.startsWith(".") && existsSync(d)) dirs.push(d);
    }
  } catch { /* ignore */ }
  const tokens = [...text.matchAll(/planning\/([A-Za-z0-9._-]+)/g)].map((m) => m[1].replace(/\.md$/, ""));
  for (const token of tokens) {
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let files: string[] = [];
      try { files = readdirSync(dir); } catch { continue; }
      const hit = files.find((f) => f === `${token}.md`) ?? files.find((f) => f.startsWith(token) && f.endsWith(".md"));
      if (!hit) continue;
      const full = join(dir, hit);
      if (seen.has(full)) break;
      seen.add(full);
      const lines = readFileSync(full, "utf8").split("\n");
      refs.push({
        path: full.slice(p.root.length + 1),
        excerpt: lines.slice(0, 120).join("\n") + (lines.length > 120 ? "\n…" : ""),
      });
      break;
    }
  }
  return refs;
}

// Ask Claude (headless, no tools — context is inlined) for 3-5 decision options.
export async function generateOptions(p: Project, question: string): Promise<{ options?: { label: string; detail: string }[]; raw?: string; error?: string }> {
  const plan = readPlan(p);
  const refs = findPlanningRefs(p, question);
  const ctx = refs.map((r) => `--- ${r.path} ---\n${r.excerpt}`).join("\n\n").slice(0, 24000);
  const planText = plan ? readFileSync(join(p.root, plan.path), "utf8").slice(0, 6000) : "";
  const prompt = `You are helping decide a project direction question for the project "${p.name}".

QUESTION: ${question}

CURRENT PLAN (plan.md):
${planText}

CONTEXT FROM PLANNING DOCS:
${ctx || "(none found)"}

Propose 3-5 concrete, mutually distinct options for answering the question. Respond with ONLY a JSON array, no prose:
[{"label": "<the option, max ~12 words, phrased as a decision>", "detail": "<one sentence: key tradeoff or why>"}]`;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const r = await promisify(execFile)("claude", ["-p", prompt], {
      cwd: p.root, encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
    });
    const out = r.stdout.trim();
    const start = out.indexOf("["), end = out.lastIndexOf("]");
    if (start !== -1 && end > start) {
      try {
        const options = JSON.parse(out.slice(start, end + 1));
        if (Array.isArray(options) && options.every((o) => o?.label)) return { options };
      } catch { /* fall through to raw */ }
    }
    return { raw: out.slice(0, 4000) };
  } catch (e: any) {
    return { error: `claude -p failed: ${String(e?.message ?? e).slice(0, 300)}` };
  }
}

// Launch an attended Claude Code session in a new tmux window, pre-briefed.
// Visible and interruptible — the human watches/steers it in the workspace.
export async function startAgentTask(p: Project, brief: string, window = "impl"): Promise<{ ok: boolean; error?: string }> {
  await ensureSession(p);
  const wid = sh("tmux", ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${p.name}`, "-c", p.root, "-n", window]).out;
  if (!wid) return { ok: false, error: "could not create tmux window" };
  // Detached-created windows are born 80x24; in iTerm2 control mode that
  // mismatch causes a native-window resize tug-of-war ("jumping") while the
  // TUI redraws. Explicitly match the session's current window geometry
  // (works even with no client attached), then let -A adopt a live client.
  // (never use resize-window -A here: with no attached client it clamps to 80x24)
  const size = sh("tmux", ["display-message", "-p", "-t", `=${p.name}`, "#{window_width}x#{window_height}"]).out;
  const m = size.match(/^(\d+)x(\d+)$/);
  if (m) sh("tmux", ["resize-window", "-t", wid, "-x", m[1], "-y", m[2]]);
  sh("tmux", ["send-keys", "-l", "-t", wid, `claude "${brief}"`]);
  sh("tmux", ["send-keys", "-t", wid, "Enter"]);
  return { ok: true };
}

export const cleanForPrompt = (s: string) => s.replace(/[;`$\\!]/g, ",").replace(/"/g, "'");

export async function startImplementation(p: Project, question: string, answer: string): Promise<{ ok: boolean; error?: string }> {
  const prompt = `We just decided a direction question in plan.md: '${cleanForPrompt(question)}' -> '${cleanForPrompt(answer)}'. Read plan.md, find the matching ticket under the Implementation queue feature, briefly plan the work, then start implementing it. Keep plan.md checkboxes current as you complete work.`;
  return startAgentTask(p, prompt);
}

// Minimal config for the "no .project-cockpit.yml" one-click fix.
export function createConfigFromTemplate(p: Project): { ok: boolean; error?: string } {
  const path = join(p.root, ".project-cockpit.yml");
  if (existsSync(path)) return { ok: false, error: ".project-cockpit.yml already exists" };
  writeFileSync(path, `name: ${basename(p.root)}
focus: ""  # one line: what's in flight right now
repo: ""
services: []
notes: ""
env_files: []
actions:
  push: { cmd: "git push", tier: confirm }
`);
  return { ok: true };
}

export function planStats(plan: Plan) {
  const tickets = plan.features.flatMap((f) => f.tickets);
  return {
    openQuestions: plan.direction.filter((d) => !d.done).length,
    featuresTotal: plan.features.length,
    featuresDone: plan.features.filter((f) => f.tickets.length > 0 && f.tickets.every((t) => t.done)).length,
    ticketsTotal: tickets.length,
    ticketsDone: tickets.filter((t) => t.done).length,
  };
}

// ---------- audit ----------
export function audit(project: string, action: string, tier: string, result: string): void {
  mkdirSync(COCKPIT_DIR, { recursive: true });
  const line = [new Date().toISOString(), project, action, tier, result].join("\t") + "\n";
  appendFileSync(AUDIT_FILE, line);
}
