// Shared state layer for the cockpit CLI and dashboard.
// The filesystem is the source of truth — everything here recomputes live
// from git/tmux/lsof on every call; nothing is cached.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function attentionItems(p: Project, git: GitState): string[] {
  const items: string[] = [];
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

// ---------- audit ----------
export function audit(project: string, action: string, tier: string, result: string): void {
  mkdirSync(COCKPIT_DIR, { recursive: true });
  const line = [new Date().toISOString(), project, action, tier, result].join("\t") + "\n";
  appendFileSync(AUDIT_FILE, line);
}
