#!/usr/bin/env bun
// cockpit — Phase 1 CLI of the project cockpit.
// Spec: planning/cockpit-design.md §4 §8, github.com/earlyadopter/ai-foundation/issues/10
// Reads: ~/.project-cockpit/registry.yml + <repo>/.project-cockpit.yml
// Writes: ~/.project-cockpit/audit.log (append-only). Live state is never cached.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";

const COCKPIT_DIR = join(homedir(), ".project-cockpit");
const REGISTRY_FILE = join(COCKPIT_DIR, "registry.yml");
const AUDIT_FILE = join(COCKPIT_DIR, "audit.log");
const TMUX_WINDOWS = ["dev", "agent", "shell"];

type Tier = "safe" | "confirm" | "manual";
interface ActionDef { cmd: string; tier?: Tier; window?: string }
interface Service { name?: string; kind?: string; url?: string; port?: number }
interface Config {
  name?: string; focus?: string; repo?: string; notes?: string;
  services?: Service[]; env_files?: string[]; actions?: Record<string, ActionDef>;
}
interface Project { root: string; name: string; cfg: Config; hasConfig: boolean }

// ---------- output helpers ----------
const isTTY = !!process.stdout.isTTY;
const paint = (code: string, s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint("1", s);
const dim = (s: string) => paint("2", s);
const green = (s: string) => paint("32", s);
const yellow = (s: string) => paint("33", s);
const red = (s: string) => paint("31", s);
const cyan = (s: string) => paint("36", s);

function die(msg: string): never {
  console.error(red(`cockpit: ${msg}`));
  process.exit(1);
}

// ---------- shell helpers ----------
function sh(cmd: string, args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: ((r.stdout ?? "") as string).trim() };
}

const execFileP = promisify(execFile);
async function shA(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await execFileP(cmd, args, { encoding: "utf8" });
    return { ok: true, out: r.stdout.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

// ---------- registry ----------
function loadRegistry(): string[] {
  if (!existsSync(REGISTRY_FILE)) return [];
  const doc = yamlLoad(readFileSync(REGISTRY_FILE, "utf8")) as { projects?: string[] } | null;
  return doc?.projects ?? [];
}

function saveRegistry(paths: string[]): void {
  mkdirSync(COCKPIT_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, yamlDump({ projects: paths }));
}

function loadProject(root: string): Project {
  const cfgPath = join(root, ".project-cockpit.yml");
  let cfg: Config = {};
  let hasConfig = false;
  if (existsSync(cfgPath)) {
    try {
      cfg = (yamlLoad(readFileSync(cfgPath, "utf8")) as Config) ?? {};
      hasConfig = true;
    } catch (e) {
      console.error(yellow(`warning: could not parse ${cfgPath}: ${e}`));
    }
  }
  return { root, name: cfg.name || basename(root), cfg, hasConfig };
}

function allProjects(): Project[] {
  return loadRegistry().map(loadProject);
}

function findProject(query: string): Project {
  const projects = allProjects();
  if (projects.length === 0) die("no projects registered — run `cockpit add <path>` first");
  const q = query.toLowerCase();
  const exact = projects.find((p) => p.name.toLowerCase() === q || basename(p.root).toLowerCase() === q);
  if (exact) return exact;
  const prefix = projects.filter((p) => p.name.toLowerCase().startsWith(q));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) die(`ambiguous project "${query}": ${prefix.map((p) => p.name).join(", ")}`);
  die(`unknown project "${query}" — known: ${projects.map((p) => p.name).join(", ")}`);
}

// ---------- live state (recomputed every call, never cached) ----------
interface GitState {
  isRepo: boolean; branch: string; dirty: string[];
  ahead: number | null; behind: number | null; hasUpstream: boolean;
  lastCommit: string; lastCommitAge: string; hasRemote: boolean;
}

async function gitState(root: string): Promise<GitState> {
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

async function tmuxSessionAlive(name: string): Promise<boolean> {
  return (await shA("tmux", ["has-session", "-t", `=${name}`])).ok;
}

async function tmuxWindows(name: string): Promise<string[]> {
  const r = await shA("tmux", ["list-windows", "-t", `=${name}`, "-F", "#{window_name}"]);
  return r.ok && r.out ? r.out.split("\n") : [];
}

async function portListening(port: number): Promise<boolean> {
  return (await shA("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).ok;
}

function localService(p: Project): Service | undefined {
  return p.cfg.services?.find((s) => s.kind === "local");
}

function attentionItems(p: Project, git: GitState): string[] {
  const items: string[] = [];
  if (git.dirty.length > 0) items.push(`${git.dirty.length} uncommitted`);
  if (git.ahead) items.push(`${git.ahead} unpushed`);
  if (git.behind) items.push(`${git.behind} behind remote`);
  if (git.isRepo && git.hasRemote && !git.hasUpstream && git.lastCommit) items.push("no upstream set");
  if (!p.hasConfig) items.push("no .project-cockpit.yml");
  return items;
}

// ---------- audit ----------
function audit(project: string, action: string, tier: string, result: string): void {
  mkdirSync(COCKPIT_DIR, { recursive: true });
  const line = [new Date().toISOString(), project, action, tier, result].join("\t") + "\n";
  appendFileSync(AUDIT_FILE, line);
}

// ---------- commands ----------
function cmdAdd(pathArg?: string): void {
  const root = resolve(pathArg || ".");
  if (!existsSync(root)) die(`no such directory: ${root}`);
  const paths = loadRegistry();
  if (paths.includes(root)) {
    console.log(`already registered: ${root}`);
    return;
  }
  paths.push(root);
  saveRegistry(paths);
  const p = loadProject(root);
  console.log(`registered ${bold(p.name)} (${root})`);
  if (!p.hasConfig) console.log(dim("hint: add a .project-cockpit.yml — template in ai-foundation/foundation/templates/common/"));
}

async function cmdList(): Promise<void> {
  const projects = allProjects();
  if (projects.length === 0) die("no projects registered — run `cockpit add <path>` first");
  const rows = await Promise.all(projects.map(async (p) => {
    const svc = localService(p);
    const [git, session, devUp] = await Promise.all([
      gitState(p.root),
      tmuxSessionAlive(p.name),
      svc?.port ? portListening(svc.port) : Promise.resolve(null),
    ]);
    const attention = attentionItems(p, git);
    return { p, git, session, devUp, attention };
  }));
  // needs-attention first, then by name
  rows.sort((a, b) => (b.attention.length ? 1 : 0) - (a.attention.length ? 1 : 0) || a.p.name.localeCompare(b.p.name));
  const nameW = Math.max(...rows.map((r) => r.p.name.length)) + 2;
  const branchW = Math.max(...rows.map((r) => (r.git.branch || "-").length)) + 2;
  for (const r of rows) {
    const dot = r.attention.length ? yellow("●") : green("●");
    const sess = r.session ? cyan("tmux") : dim("    ");
    const dev = r.devUp === null ? dim("     ") : r.devUp ? green(`:${localService(r.p)!.port}`) : dim(`:${localService(r.p)!.port}✗`);
    const att = r.attention.length ? yellow(r.attention.join(", ")) : dim("clean");
    console.log(`${dot} ${bold(r.p.name.padEnd(nameW))}${(r.git.branch || "-").padEnd(branchW)}${sess}  ${dev.padEnd(isTTY ? 14 : 6)} ${att}`);
  }
}

async function cmdStatus(query: string): Promise<void> {
  const p = findProject(query);
  const git = await gitState(p.root);
  const attention = attentionItems(p, git);

  console.log(`\n${bold(p.name)}  ${dim(p.root)}`);
  if (p.cfg.focus) console.log(`  focus: ${p.cfg.focus}`);
  if (p.cfg.repo) console.log(`  repo:  ${p.cfg.repo}`);

  if (attention.length) console.log(`\n  ${yellow("▲ needs attention:")} ${yellow(attention.join(", "))}`);

  if (git.isRepo) {
    const ab = git.hasUpstream ? ` ↑${git.ahead} ↓${git.behind}` : git.hasRemote ? " (no upstream)" : " (no remote)";
    console.log(`\n  ${bold("git")}  ${git.branch}${ab}`);
    if (git.lastCommit) console.log(`       last: ${git.lastCommit} ${dim(`(${git.lastCommitAge})`)}`);
    if (git.dirty.length) {
      console.log(`       dirty (${git.dirty.length}):`);
      for (const line of git.dirty.slice(0, 10)) console.log(`         ${line}`);
      if (git.dirty.length > 10) console.log(dim(`         … and ${git.dirty.length - 10} more`));
    }
  } else {
    console.log(`\n  ${bold("git")}  ${dim("not a git repository")}`);
  }

  const alive = await tmuxSessionAlive(p.name);
  console.log(`\n  ${bold("tmux")} ${alive ? green(`session "${p.name}" running`) + dim(` (windows: ${(await tmuxWindows(p.name)).join(", ")})`) : dim(`no session — cockpit go ${p.name}`)}`);

  if (p.cfg.services?.length) {
    console.log(`\n  ${bold("services")}`);
    for (const s of p.cfg.services) {
      const up = s.port ? ((await portListening(s.port)) ? green(" [listening]") : dim(" [down]")) : "";
      console.log(`       ${(s.name ?? s.kind ?? "?").padEnd(22)} ${s.url ?? ""}${up}`);
    }
  }

  if (p.cfg.env_files?.length) {
    const parts = p.cfg.env_files.map((f) => (existsSync(join(p.root, f)) ? f : `${f} ${red("(missing)")}`));
    console.log(`\n  ${bold("env")}  ${parts.join(", ")}`);
  }

  if (p.cfg.actions && Object.keys(p.cfg.actions).length) {
    console.log(`\n  ${bold("actions")}`);
    for (const [name, a] of Object.entries(p.cfg.actions)) {
      const tier = a.tier ?? "safe";
      const tierLabel = tier === "safe" ? green(tier) : tier === "confirm" ? yellow(tier) : red(tier);
      console.log(`       ${name.padEnd(12)} ${tierLabel.padEnd(isTTY ? 17 : 8)} ${dim(a.cmd)}`);
    }
  }
  console.log();
}

async function ensureSession(p: Project): Promise<boolean> {
  if (await tmuxSessionAlive(p.name)) return false;
  const first = TMUX_WINDOWS[0];
  if (!sh("tmux", ["new-session", "-d", "-s", p.name, "-c", p.root, "-n", first]).ok)
    die(`failed to create tmux session "${p.name}"`);
  for (const w of TMUX_WINDOWS.slice(1))
    sh("tmux", ["new-window", "-d", "-t", `=${p.name}`, "-c", p.root, "-n", w]);
  sh("tmux", ["select-window", "-t", `=${p.name}:${first}`]);
  return true;
}

async function cmdGo(query: string, cc = false): Promise<void> {
  const p = findProject(query);
  const created = await ensureSession(p);
  audit(p.name, "go", "safe", created ? "session-created" : "session-existed");
  if (process.env.TMUX) {
    // already inside tmux — just jump; -CC can't nest
    spawnSync("tmux", ["switch-client", "-t", `=${p.name}`], { stdio: "inherit" });
  } else if (process.stdin.isTTY) {
    const attach = cc ? ["-CC", "attach", "-t", `=${p.name}`] : ["attach", "-t", `=${p.name}`];
    spawnSync("tmux", attach, { stdio: "inherit" });
  } else {
    console.log(`${created ? "created" : "running"}: tmux session "${p.name}" — attach with:
  tmux attach -t ${p.name}        # classic tmux
  tmux -CC attach -t ${p.name}    # iTerm2 native windows/tabs`);
  }
}

const OPEN_TARGETS = ["cursor", "obsidian", "finder", "github", "deploy", "dev"] as const;

function cmdOpen(query: string, target?: string): void {
  const p = findProject(query);
  if (!target) die(`what to open? one of: ${OPEN_TARGETS.join(", ")}`);
  const svcUrl = (kinds: string[]) => p.cfg.services?.find((s) => s.kind && kinds.includes(s.kind))?.url;
  let result = "";
  switch (target) {
    case "cursor": {
      const r = sh("cursor", [p.root]);
      if (!r.ok) sh("open", ["-a", "Cursor", p.root]);
      result = p.root;
      break;
    }
    case "obsidian":
      if (!p.cfg.notes) die(`no notes: configured in ${p.name}/.project-cockpit.yml`);
      sh("open", [p.cfg.notes]);
      result = p.cfg.notes;
      break;
    case "finder":
      sh("open", [p.root]);
      result = p.root;
      break;
    case "github":
      if (!p.cfg.repo) die(`no repo: configured for ${p.name}`);
      sh("open", [p.cfg.repo]);
      result = p.cfg.repo;
      break;
    case "deploy": {
      const url = svcUrl(["vercel", "render"]);
      if (!url) die(`no vercel/render service configured for ${p.name}`);
      sh("open", [url]);
      result = url;
      break;
    }
    case "dev": {
      const url = svcUrl(["local"]);
      if (!url) die(`no local service configured for ${p.name}`);
      sh("open", [url]);
      result = url;
      break;
    }
    default:
      die(`unknown target "${target}" — one of: ${OPEN_TARGETS.join(", ")}`);
  }
  audit(p.name, `open:${target}`, "safe", result);
  console.log(`opened ${target}: ${result}`);
}

async function cmdRun(query: string, actionName?: string): Promise<void> {
  const p = findProject(query);
  const actions = p.cfg.actions ?? {};
  if (!actionName) {
    const names = Object.keys(actions);
    die(names.length ? `which action? one of: ${names.join(", ")}` : `no actions defined in ${p.name}/.project-cockpit.yml`);
  }
  const action = actions[actionName];
  if (!action?.cmd) die(`unknown action "${actionName}" — defined: ${Object.keys(actions).join(", ") || "(none)"}`);
  const tier: Tier = action.tier ?? "safe";

  if (tier === "manual") {
    audit(p.name, actionName, tier, "refused-manual-tier");
    console.log(`${red("manual tier")} — the cockpit never runs this. Run it yourself:\n`);
    console.log(`  cd ${p.root}`);
    console.log(`  ${action.cmd}\n`);
    process.exit(2);
  }

  if (tier === "confirm") {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(`Run ${bold(action.cmd)} in ${bold(p.name)}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      audit(p.name, actionName, tier, "declined");
      console.log("declined.");
      process.exit(2);
    }
  }

  if (action.window) {
    await ensureSession(p);
    sh("tmux", ["send-keys", "-t", `=${p.name}:${action.window}`, action.cmd, "Enter"]);
    audit(p.name, actionName, tier, `sent-to-tmux:${action.window}`);
    console.log(`sent to tmux ${p.name}:${action.window} — watch with: tmux attach -t ${p.name}`);
    return;
  }

  const r = spawnSync("bash", ["-lc", action.cmd], { cwd: p.root, stdio: "inherit" });
  audit(p.name, actionName, tier, `exit=${r.status}`);
  process.exit(r.status ?? 1);
}

function cmdAudit(): void {
  if (!existsSync(AUDIT_FILE)) {
    console.log(dim("audit log is empty"));
    return;
  }
  process.stdout.write(readFileSync(AUDIT_FILE, "utf8"));
}

function help(): void {
  console.log(`${bold("cockpit")} — local project cockpit (Phase 1)

  cockpit list                      all projects, one status line each
  cockpit status <project>          full picture: git, tmux, services, actions
  cockpit go <project>              attach-or-create the project tmux session
                                    (native iTerm2 tabs by default in iTerm2;
                                     --no-cc for classic tmux UI, --cc to force)
  cockpit open <project> <target>   ${OPEN_TARGETS.join(" | ")}
  cockpit run <project> <action>    run a declared action (tier-enforced, audited)
  cockpit add [path]                register a project (default: cwd)
  cockpit audit                     print the audit log

  registry: ${REGISTRY_FILE}
  per-repo config: .project-cockpit.yml (template in ai-foundation)`);
}

// ---------- main ----------
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "list": case "ls": await cmdList(); break;
  case "status": case "st": await cmdStatus(args[0] ?? die("usage: cockpit status <project>")); break;
  case "go": {
    // In iTerm2, control mode (native tabs) is the default — classic tmux UI via --no-cc.
    const forceCc = args.includes("--cc") || args.includes("-cc");
    const noCc = args.includes("--no-cc");
    const cc = forceCc || (!noCc && process.env.TERM_PROGRAM === "iTerm.app");
    const rest = args.filter((a) => !["--cc", "-cc", "--no-cc"].includes(a));
    await cmdGo(rest[0] ?? die("usage: cockpit go <project> [--cc|--no-cc]"), cc);
    break;
  }
  case "open": cmdOpen(args[0] ?? die("usage: cockpit open <project> <target>"), args[1]); break;
  case "run": await cmdRun(args[0] ?? die("usage: cockpit run <project> <action>"), args[1]); break;
  case "add": cmdAdd(args[0]); break;
  case "audit": cmdAudit(); break;
  case undefined: case "help": case "-h": case "--help": help(); break;
  default: die(`unknown command "${cmd}" — try: cockpit help`);
}
