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
  name?: string; focus?: string; repo?: string; notes?: string; changelog?: string;
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

export function attentionItems(p: Project, git: GitState, agent?: AgentInfo): string[] {
  const items: string[] = [];
  if (agent?.state === "waiting") items.push("agent waiting for you");
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

// ---------- audit ----------
export function audit(project: string, action: string, tier: string, result: string): void {
  mkdirSync(COCKPIT_DIR, { recursive: true });
  const line = [new Date().toISOString(), project, action, tier, result].join("\t") + "\n";
  appendFileSync(AUDIT_FILE, line);
}
