#!/usr/bin/env bun
// cockpit — CLI of the project cockpit (Phase 1 + Phase 2 `dash`).
// Vision & design record: docs/vision.md
// Shared state layer: ./state.ts. Dashboard server: ./server.ts.

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AUDIT_FILE, COCKPIT_DIR, EVENTS_FILE, OPEN_TARGETS, REGISTRY_FILE,
  type Project, type Tier,
  accentColor, agentState, allProjects, attentionItems, audit, claudeCwds, ensureSession, focusWindow,
  gitState, readFoundation,
  humanAge, loadProject, loadRegistry, localService, openTarget, planStats, portListening,
  readPlan, recordAgentEvent, saveRegistry, sendToWindow, sh, shortAge, tmuxSessionAlive, tmuxWindows,
} from "./state.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { effectiveRoots, setRoot } from "./home.ts";
import { fileURLToPath } from "node:url";

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
  if (!p.hasConfig) {
    console.log(dim(`hint: add a .project-cockpit.yml at the repo root to declare services and actions, e.g.
  name: ${p.name}
  focus: "what's in flight right now"
  services: [{ name: dev, kind: local, url: "http://localhost:3000", port: 3000 }]
  actions:
    dev:  { cmd: "npm run dev", window: dev }
    push: { cmd: "git push", tier: manual }
(optional — without it you still get git + tmux; the dashboard can also create one for you)`));
  }
}

async function cmdList(): Promise<void> {
  const projects = allProjects();
  if (projects.length === 0) {
    console.log(`${bold("cockpit")} — no projects registered yet.

  Easiest: open the dashboard and point it at the folder that holds your projects —
  it lists the sub-folders and you pick which ones to add:

    cockpit                           opens http://localhost:4400

  Or register one from here (a git repo, or any folder you work in):

    cockpit add ~/projects/my-app     # or: cd into it and just \`cockpit add\`

  Just looking?  cockpit demo        sample projects in a sandbox; touches nothing of yours
`);
    return;
  }
  const cwds = await claudeCwds();
  const rows = await Promise.all(projects.map(async (p) => {
    const svc = localService(p);
    const [git, session, devUp, agent] = await Promise.all([
      gitState(p.root),
      tmuxSessionAlive(p.name),
      svc?.port ? portListening(svc.port) : Promise.resolve(null),
      agentState(p, cwds),
    ]);
    const attention = attentionItems(p, git, agent, readPlan(p), readFoundation(p));
    return { p, git, session, devUp, agent, attention };
  }));
  // needs-attention first; within those, the agent that has waited longest on top
  const waitSec = (r: (typeof rows)[number]) => (r.agent.state === "waiting" ? r.agent.ageSec ?? 0 : -1);
  rows.sort((a, b) =>
    (b.attention.length ? 1 : 0) - (a.attention.length ? 1 : 0) ||
    waitSec(b) - waitSec(a) ||
    a.p.name.localeCompare(b.p.name));
  const nameW = Math.max(...rows.map((r) => r.p.name.length)) + 2;
  const branchW = Math.max(...rows.map((r) => (r.git.branch || "-").length)) + 2;
  for (const r of rows) {
    const dot = r.attention.length ? yellow("●") : green("●");
    const mark = isTTY ? paint(`38;5;${accentColor(r.p).ansi256}`, "▪") + " " : "";
    const sess = r.session ? cyan("tmux") : dim("    ");
    const dev = r.devUp === null ? dim("     ") : r.devUp ? green(`:${localService(r.p)!.port}`) : dim(`:${localService(r.p)!.port}✗`);
    const agRaw = r.agent.state === "working" ? "agent✳"
      : r.agent.state === "waiting" ? `agent✋${shortAge(r.agent.ageSec)}`
      : r.agent.state === "idle" ? "agent…" : "";
    // pad the plain text BEFORE painting — ANSI escape lengths vary by color code
    const agPad = agRaw.padEnd(11);
    const ag = r.agent.state === "working" ? cyan(agPad)
      : r.agent.state === "waiting" ? ((r.agent.ageSec ?? 0) >= 600 ? red(agPad) : yellow(agPad))
      : dim(agPad);
    const att = r.attention.length ? yellow(r.attention.join(", ")) : dim("clean");
    console.log(`${dot} ${mark}${bold(r.p.name.padEnd(nameW))}${(r.git.branch || "-").padEnd(branchW)}${sess}  ${dev.padEnd(isTTY ? 14 : 6)} ${ag} ${att}`);
  }
}

async function cmdStatus(query: string): Promise<void> {
  const p = findProject(query);
  const [git, agent] = await Promise.all([gitState(p.root), claudeCwds().then((c) => agentState(p, c))]);
  const plan = readPlan(p);
  const attention = attentionItems(p, git, agent, plan, readFoundation(p));

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

  const agentLabel = agent.state === "working" ? cyan("working ✳")
    : agent.state === "waiting" ? yellow("waiting for you ✋")
    : agent.state === "idle" ? dim("idle") : dim("none");
  console.log(`\n  ${bold("agent")} ${agentLabel}${agent.state !== "none" ? dim(` — ${agent.detail}${agent.ageSec !== null ? `, last activity ${humanAge(agent.ageSec)}` : ""}${agent.procs > 1 ? `, ${agent.procs} instances` : ""}${agent.source === "hook" ? ", via hook" : ""}`) : ""}`);
  if (agent.state === "waiting" && agent.lastMessage) {
    const msg = agent.lastMessage.replace(/\s+/g, " ").slice(0, 200);
    console.log(dim(`        last said: “${msg}${agent.lastMessage.length > 200 ? "…" : ""}”`));
  }

  if (plan) {
    const s = planStats(plan);
    const q = s.openQuestions ? yellow(`, ${s.openQuestions} open question${s.openQuestions > 1 ? "s" : ""}`) : "";
    console.log(`\n  ${bold("plan")} ${s.featuresDone}/${s.featuresTotal} features done, ${s.ticketsDone}/${s.ticketsTotal} tickets${q} ${dim(`(${plan.path})`)}`);
  }

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

async function cmdGo(query: string, cc = false, window?: string): Promise<void> {
  const p = findProject(query);
  const created = await ensureSession(p).catch((e) => die(String(e.message ?? e)));
  if (window) {
    const r = await focusWindow(p, window);
    if (!r.ok) console.error(yellow(`cockpit: ${r.error}`));
    else if (r.window !== window) console.error(dim(`no window "${window}" — focusing "${r.window}"`));
  }
  audit(p.name, "go", "safe", `${created ? "session-created" : "session-existed"}${window ? ` window=${window}` : ""}`);
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

function cmdOpen(query: string, target?: string): void {
  const p = findProject(query);
  if (!target) die(`what to open? one of: ${OPEN_TARGETS.join(", ")}`);
  const r = openTarget(p, target);
  if (!r.ok) die(r.error!);
  audit(p.name, `open:${target}`, "safe", r.result!);
  console.log(`opened ${target}: ${r.result}`);
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
    await sendToWindow(p, action.window, action.cmd).catch((e) => die(String(e.message ?? e)));
    audit(p.name, actionName, tier, `sent-to-tmux:${action.window}`);
    console.log(`sent to tmux ${p.name}:${action.window} — watch with: tmux attach -t ${p.name}`);
    return;
  }

  const r = spawnSync("bash", ["-lc", action.cmd], { cwd: p.root, stdio: "inherit" });
  audit(p.name, actionName, tier, `exit=${r.status}`);
  process.exit(r.status ?? 1);
}

// ---------- launchd (survive reboots) ----------
const LAUNCH_LABEL = "com.project-cockpit.dash";
const PLIST_PATH = join(process.env.HOME ?? "~", "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);

function installLaunchAgent(port: number, host?: string): void {
  const serverPath = new URL("./server.ts", import.meta.url).pathname;
  const logPath = join(process.env.HOME ?? "~", ".project-cockpit", "dash.log");
  // No token in the plist (it would be visible in `ps`/the plist file) — for
  // non-loopback hosts the server reads/creates ~/.project-cockpit/token itself.
  const hostArgs = host ? `
    <string>--host</string>
    <string>${host}</string>` : "";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${serverPath}</string>
    <string>${port}</string>${hostArgs}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- launchd jobs default to NOT materializing dataless (cloud-evicted) files;
       reads of Dropbox "online-only" plan.md/CHANGELOG.md/.git/HEAD then fail with EDEADLK. -->
  <key>MaterializeDatalessFiles</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict></plist>
`;
  writeFileSync(PLIST_PATH, plist);
  const uid = process.getuid?.() ?? 501;
  sh("launchctl", ["bootout", `gui/${uid}/${LAUNCH_LABEL}`]); // ignore failure (not loaded)
  // bootout returns before the job is gone; bootstrapping straight after fails
  // ("Bootstrap failed: 5") — so a reinstall waits for the unload, then retries.
  let r = { ok: false, out: "" };
  for (let i = 0; i < 20 && !r.ok; i++) {
    if (!sh("launchctl", ["print", `gui/${uid}/${LAUNCH_LABEL}`]).ok) r = sh("launchctl", ["bootstrap", `gui/${uid}`, PLIST_PATH]);
    if (!r.ok) Bun.sleepSync(250);
  }
  if (!r.ok) die(`launchctl bootstrap failed — try: launchctl bootstrap gui/${uid} ${PLIST_PATH}`);
  console.log(`installed: dashboard now starts at login and stays up (port ${port}${host ? `, host ${host}` : ""})`);
  console.log(dim(`plist: ${PLIST_PATH}\nlogs:  ${logPath}\nremove with: cockpit dash --uninstall`));
  if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    console.log(dim(`non-loopback host: token auth is enforced — see the tokened URL in ${logPath}\nsetup guide: docs/remote-access.md`));
  }
}

function uninstallLaunchAgent(): void {
  const uid = process.getuid?.() ?? 501;
  sh("launchctl", ["bootout", `gui/${uid}/${LAUNCH_LABEL}`]);
  if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
  console.log("uninstalled: dashboard no longer starts at login");
}

// ---------- finding "the" dashboard (`cockpit`, `cockpit dash`, `cockpit doctor`) ----------
// The installed launchd agent is the source of truth for where the dashboard lives;
// without one, the default port. Liveness is a real HTTP probe, never a cached flag.
const DEFAULT_PORT = 4400;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
interface DashTarget { port: number; host?: string; token?: string }

function plistValue(key: string, format: "json" | "raw" = "json"): string | null {
  if (!existsSync(PLIST_PATH)) return null;
  const r = sh("plutil", ["-extract", key, format, "-o", "-", PLIST_PATH]);
  return r.ok ? r.out : null;
}

function installedTarget(): (DashTarget & { serverPath: string }) | null {
  const raw = plistValue("ProgramArguments");
  if (!raw) return null;
  const a: string[] = JSON.parse(raw);
  const h = a.indexOf("--host");
  return { port: Number(a[2]) || DEFAULT_PORT, host: h >= 0 ? a[h + 1] : undefined, serverPath: a[1] ?? "" };
}

// Mirrors the server: loopback binds need no token; others read ~/.project-cockpit/token.
function targetToken(t: DashTarget): string | undefined {
  if (t.token) return t.token;
  if (!t.host || LOOPBACK.has(t.host)) return process.env.COCKPIT_TOKEN || undefined;
  const f = join(COCKPIT_DIR, "token");
  return existsSync(f) ? readFileSync(f, "utf8").trim() || undefined : undefined;
}

function dashUrl(t: DashTarget): string {
  const loop = !t.host || LOOPBACK.has(t.host);
  const tok = targetToken(t);
  return `http://${loop ? "localhost" : t.host}:${t.port}/${tok ? `?token=${tok}` : ""}`;
}

// "ours" = a cockpit answered (200, or 401 from its token gate); "other" = something else owns the port.
async function probe(t: DashTarget): Promise<"ours" | "other" | "down"> {
  const host = !t.host || LOOPBACK.has(t.host) ? "127.0.0.1" : t.host;
  const tok = targetToken(t);
  try {
    const r = await fetch(`http://${host}:${t.port}/`, {
      headers: tok ? { authorization: `Bearer ${tok}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    // Match the page's own markers, not just the word — a file server listing a
    // folder named project-cockpit would contain "cockpit" too.
    const body = await r.text();
    const ours = r.status === 200 ? body.includes("<title>cockpit</title>") : r.status === 401 && body.includes("`cockpit dash`");
    return ours ? "ours" : "other";
  } catch {
    return (await portListening(t.port)) ? "other" : "down";
  }
}

async function waitUntilUp(t: DashTarget, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(300)) {
    if ((await probe(t)) === "ours") return true;
  }
  return false;
}

function agentStatus(): { loaded: boolean; pid?: number } {
  const uid = process.getuid?.() ?? 501;
  const r = sh("launchctl", ["print", `gui/${uid}/${LAUNCH_LABEL}`]);
  if (!r.ok) return { loaded: false };
  const pid = Number(r.out.match(/^\s*pid = (\d+)/m)?.[1]);
  return { loaded: true, pid: pid || undefined };
}

// `cockpit` with no args: open the dashboard, starting (or first-time installing) it if needed.
async function cmdHome(): Promise<void> {
  const installed = installedTarget();
  const t: DashTarget = installed ?? { port: DEFAULT_PORT };
  let state = await probe(t);
  if (state === "other") die(`port ${t.port} is taken by something that isn't the cockpit — see: lsof -nP -iTCP:${t.port} -sTCP:LISTEN`);
  if (state === "down") {
    if (process.platform !== "darwin") {
      console.log(dim("no login agent on this platform — running the dashboard in this terminal"));
      return cmdDash([String(t.port)]);
    }
    const uid = process.getuid?.() ?? 501;
    if (installed) {
      console.log(dim("dashboard not answering — restarting its login agent…"));
      if (agentStatus().loaded) sh("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCH_LABEL}`]);
      else sh("launchctl", ["bootstrap", `gui/${uid}`, PLIST_PATH]);
    } else {
      console.log("first run: installing the dashboard as a login item, so it is simply always there");
      installLaunchAgent(t.port);
    }
    if (!(await waitUntilUp(t, 10_000))) die("dashboard did not come up within 10s — run: cockpit doctor");
  }
  const url = dashUrl(t);
  console.log(`cockpit dashboard: ${url}`);
  sh("open", [url]);
}

async function cmdDash(args: string[]): Promise<void> {
  const port = Number(args.find((a) => /^\d+$/.test(a))) || DEFAULT_PORT;
  const flagVal = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const host = flagVal("--host");
  const token = flagVal("--token");
  if (args.includes("--install")) { installLaunchAgent(port, host); return; }
  if (args.includes("--uninstall")) { uninstallLaunchAgent(); return; }
  // Only auto-open when the plain localhost URL will actually work (no token
  // in play) — otherwise the server has printed the tokened login URL.
  const tokenInPlay = token || process.env.COCKPIT_TOKEN || (host && !LOOPBACK.has(host));
  const t: DashTarget = { port, host, token };
  const state = await probe(t);
  if (state === "ours") {
    const via = installedTarget()?.port === port && agentStatus().loaded ? ` (login agent ${LAUNCH_LABEL})` : "";
    console.log(`already running${via}: ${dashUrl(t)} — nothing to start`);
    if (process.stdout.isTTY && !tokenInPlay) sh("open", [dashUrl(t)]);
    return;
  }
  if (state === "other") die(`port ${port} is taken by something that isn't the cockpit — see: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  const { startServer } = await import("./server.ts");
  startServer(port, { host, token });
  if (process.stdout.isTTY && !tokenInPlay) sh("open", [`http://localhost:${port}`]);
}

// `cockpit demo [port]`: sample projects in a sandbox COCKPIT_DIR, served on its own
// port. Your registry, plans and login agent are never touched.
async function cmdDemo(args: string[]): Promise<void> {
  const port = Number(args.find((a) => /^\d+$/.test(a))) || 4401;
  const { makeDemo } = await import("./demo.ts");
  const dir = join(COCKPIT_DIR + "-demo");
  const state = makeDemo(dir);
  console.log(`demo projects: ${dir}/projects  (rebuilt on every run)`);
  const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, serverPath, String(port)], {
    env: { ...process.env, COCKPIT_DIR: state, COCKPIT_TOKEN: "" }, stdout: "inherit", stderr: "inherit",
  });
  if (await waitUntilUp({ port }, 8000)) { if (process.stdout.isTTY) sh("open", [`http://localhost:${port}`]); }
  else console.error("demo server did not come up — see the output above");
  await child.exited;
}

// `cockpit roots [add|rm <path>]`: folders whose sub-folders the dashboard offers as projects.
function cmdRoots(args: string[]): void {
  const [op, path] = args;
  if (op === "add" || op === "rm") {
    if (!path) die(`usage: cockpit roots ${op} <path>`);
    const r = setRoot(path, op === "add");
    if (!r.ok) die(r.error!);
    console.log(`${op === "add" ? "scanning" : "stopped scanning"} ${r.path}`);
    return;
  }
  const roots = effectiveRoots();
  if (!roots.length) { console.log(`no roots yet — cockpit roots add <folder-of-projects>`); return; }
  for (const r of roots) console.log(`${r.path}${r.explicit ? "" : dim("  (parent of registered projects)")}`);
}

// `cockpit doctor`: one screen answering "why isn't my dashboard there?"
async function cmdDoctor(): Promise<void> {
  type Level = "ok" | "warn" | "fail";
  const rows: { level: Level; what: string; fix?: string }[] = [];
  const add = (level: Level, what: string, fix?: string) => rows.push({ level, what, fix });

  add("ok", `bun ${Bun.version} (${process.execPath})`);

  const paths = loadRegistry();
  const missing = paths.filter((p) => !existsSync(p));
  if (paths.length === 0) add("warn", "registry is empty", "cockpit add <path-to-a-project>");
  else if (missing.length) add("fail", `${missing.length} of ${paths.length} registered paths don't exist: ${missing.join(", ")}`, `edit ${REGISTRY_FILE}`);
  else add("ok", `${paths.length} projects registered, all paths exist`);

  const installed = installedTarget();
  const here = fileURLToPath(new URL("./server.ts", import.meta.url));
  if (process.platform !== "darwin") add("ok", "no login agent (macOS-only) — start with: cockpit dash");
  else if (!installed) add("warn", "no login agent — the dashboard runs only while `cockpit dash` does", "cockpit   (installs it on first run)");
  else {
    if (installed.serverPath === here) add("ok", `login agent points at this checkout (port ${installed.port}${installed.host ? `, host ${installed.host}` : ""})`);
    else add("fail", `login agent runs a different checkout: ${installed.serverPath}`, "cockpit dash --uninstall && cockpit dash --install");
    if (plistValue("MaterializeDatalessFiles", "raw") !== "true") add("warn", "login agent can't read cloud-evicted files (MaterializeDatalessFiles missing)", "cockpit dash --uninstall && cockpit dash --install");
    const a = agentStatus();
    if (!a.loaded) add("fail", "login agent installed but not loaded", `launchctl bootstrap gui/${process.getuid?.() ?? 501} ${PLIST_PATH}`);
    else if (!a.pid) add("fail", "login agent loaded but not running", `see ${join(COCKPIT_DIR, "dash.log")}`);
    else add("ok", `login agent running (pid ${a.pid})`);
  }

  const t: DashTarget = installed ?? { port: DEFAULT_PORT };
  const t0 = Date.now();
  const state = await probe(t);
  if (state === "ours") add("ok", `dashboard answering at ${dashUrl(t)} (${Date.now() - t0} ms)`);
  else if (state === "other") add("fail", `port ${t.port} is taken by something that isn't the cockpit`, `lsof -nP -iTCP:${t.port} -sTCP:LISTEN`);
  else add("fail", `nothing answering on port ${t.port}`, "cockpit");

  const settings = readClaudeSettings();
  const hooked = HOOK_EVENTS.filter((ev) => hasCockpitHook(settings, ev));
  if (hooked.length === HOOK_EVENTS.length) add("ok", "Claude Code hooks installed (precise agent state)");
  else add("warn", `Claude Code hooks: ${hooked.length}/${HOOK_EVENTS.length} — agent state is heuristic`, "cockpit hooks --install   (optional)");

  const mark = { ok: green("✓"), warn: yellow("!"), fail: red("✗") };
  for (const r of rows) {
    console.log(`${mark[r.level]} ${r.what}`);
    if (r.fix) console.log(dim(`    fix: ${r.fix}`));
  }
  if (rows.some((r) => r.level === "fail")) process.exit(1);
}

// ---------- Claude Code hooks (opt-in precise agent events) ----------
// Installs Notification / Stop / UserPromptSubmit hooks into ~/.claude/settings.json.
// Each fires `cockpit _hook-event`, which appends one JSON line to
// ~/.project-cockpit/agent-events.log. Observe-only: hooks report, never drive.
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const HOOK_EVENTS = ["Notification", "Stop", "UserPromptSubmit"];
const HOOK_MARKER = "_hook-event";

function hookCommand(): string {
  // fileURLToPath, not .pathname — the latter percent-encodes spaces etc.,
  // which would write a nonexistent path into settings.json (hook never fires)
  const bin = fileURLToPath(new URL("../bin/cockpit", import.meta.url));
  return `'${bin}' ${HOOK_MARKER}`;
}

function readClaudeSettings(): any {
  if (!existsSync(CLAUDE_SETTINGS)) return {};
  try { return JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")); }
  catch (e) { die(`could not parse ${CLAUDE_SETTINGS} — fix it first (${e})`); }
}

function hasCockpitHook(settings: any, ev: string): boolean {
  return (settings.hooks?.[ev] ?? []).some((h: any) => (h.hooks ?? []).some((x: any) => String(x.command ?? "").includes(HOOK_MARKER)));
}

function cmdHooks(args: string[]): void {
  const settings = readClaudeSettings();
  const hasOurs = (ev: string) => hasCockpitHook(settings, ev);

  if (args.includes("--install")) {
    const missing = HOOK_EVENTS.filter((ev) => !hasOurs(ev));
    if (missing.length === 0) { console.log("already installed — nothing to do"); return; }
    // backup only when actually modifying — a repeat install must not clobber
    // the pristine pre-cockpit backup with an already-hooked copy
    if (existsSync(CLAUDE_SETTINGS)) writeFileSync(CLAUDE_SETTINGS + ".bak-cockpit", readFileSync(CLAUDE_SETTINGS));
    settings.hooks ??= {};
    let added = 0;
    for (const ev of missing) {
      settings.hooks[ev] ??= [];
      settings.hooks[ev].push({ hooks: [{ type: "command", command: hookCommand() }] });
      added++;
    }
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
    console.log(added
      ? `installed ${added} hook${added > 1 ? "s" : ""} (${HOOK_EVENTS.join(", ")}) in ${CLAUDE_SETTINGS}
  events land in ${EVENTS_FILE}
  backup of previous settings: ${CLAUDE_SETTINGS}.bak-cockpit
  agent state now reads precise events instead of transcript heuristics (new sessions only)`
      : "already installed — nothing to do");
    return;
  }

  if (args.includes("--uninstall")) {
    if (!settings.hooks) { console.log("no hooks installed"); return; }
    for (const ev of HOOK_EVENTS) {
      if (!settings.hooks[ev]) continue;
      settings.hooks[ev] = settings.hooks[ev].filter((h: any) => !(h.hooks ?? []).some((x: any) => String(x.command ?? "").includes(HOOK_MARKER)));
      if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
    console.log(`removed cockpit hooks from ${CLAUDE_SETTINGS} — agent state falls back to heuristics`);
    return;
  }

  const status = HOOK_EVENTS.map((ev) => `${hasOurs(ev) ? green("✓") : dim("✗")} ${ev}`).join("  ");
  console.log(`cockpit hooks (precise agent events for the dashboard/CLI):\n  ${status}`);
  console.log(dim(`  install with: cockpit hooks --install   (writes to ${CLAUDE_SETTINGS})`));
  if (existsSync(EVENTS_FILE)) {
    const tail = readFileSync(EVENTS_FILE, "utf8").trimEnd().split("\n").slice(-5);
    console.log(dim(`  last events (${EVENTS_FILE}):`));
    for (const l of tail) console.log(dim(`    ${l}`));
  }
}

async function cmdHookEvent(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  recordAgentEvent(raw);
}

function cmdAudit(): void {
  if (!existsSync(AUDIT_FILE)) {
    console.log(dim("audit log is empty"));
    return;
  }
  process.stdout.write(readFileSync(AUDIT_FILE, "utf8"));
}

function help(): void {
  console.log(`${bold("cockpit")} — local project cockpit

  cockpit                           open the dashboard (starts it — or, first time,
                                    installs it as a login item — if it isn't up)
  cockpit doctor                    why isn't the dashboard there? one-screen check
  cockpit list                     all projects, one status line each
  cockpit status <project>          full picture: git, tmux, services, actions
  cockpit go <project>              attach-or-create the project tmux session
                                    (native iTerm2 tabs by default in iTerm2;
                                     --no-cc for classic tmux UI, --cc to force)
  cockpit go <project> -w <window>  land on a specific window (agent/impl/dev/…)
  cockpit open <project> <target>   ${OPEN_TARGETS.join(" | ")}
  cockpit run <project> <action>    run a declared action (tier-enforced, audited)
  cockpit hooks [--install|--uninstall]
                                    precise agent events via Claude Code hooks
                                    (opt-in; without them detection is heuristic)
  cockpit dash [port]               run the dashboard in this terminal (default
                                    http://localhost:4400; says so if already up)
  cockpit dash --host <ip>          bind beyond localhost (e.g. a Tailscale IP);
                                    enforces bearer-token auth — docs/remote-access.md
  cockpit dash --token <t>          override the token (default: ~/.project-cockpit/token)
  cockpit dash --install            auto-start the dashboard at login (launchd,
                                    combines with --host)
  cockpit dash --uninstall          remove the login auto-start
  cockpit add [path]                register a project (default: cwd)
  cockpit roots [add|rm <path>]     folders whose sub-folders the dashboard offers
  cockpit demo [port]               try it on sample projects (sandbox, port 4401)
  cockpit audit                     print the audit log

  registry: ${REGISTRY_FILE}
  per-repo config: .project-cockpit.yml (optional — minimal example in the README)`);
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
    const wIdx = args.findIndex((a) => a === "--window" || a === "-w");
    const window = wIdx >= 0 ? args[wIdx + 1] : undefined;
    const rest = args.filter((a, i) => !["--cc", "-cc", "--no-cc", "--window", "-w"].includes(a) && (wIdx < 0 || i !== wIdx + 1));
    await cmdGo(rest[0] ?? die("usage: cockpit go <project> [--cc|--no-cc] [-w <window>]"), cc, window);
    break;
  }
  case "hooks": cmdHooks(args); break;
  case "_hook-event": await cmdHookEvent(); break;
  case "open": cmdOpen(args[0] ?? die("usage: cockpit open <project> <target>"), args[1]); break;
  case "run": await cmdRun(args[0] ?? die("usage: cockpit run <project> <action>"), args[1]); break;
  case "dash": await cmdDash(args); break;
  case "doctor": await cmdDoctor(); break;
  case "demo": await cmdDemo(args); break;
  case "roots": cmdRoots(args); break;
  case "add": cmdAdd(args[0]); break;
  case "audit": cmdAudit(); break;
  // No args in a terminal = "show me my projects"; piped/scripted keeps printing help.
  case undefined: if (process.stdout.isTTY) await cmdHome(); else help(); break;
  case "help": case "-h": case "--help": help(); break;
  default: die(`unknown command "${cmd}" — try: cockpit help`);
}
