#!/usr/bin/env bun
// cockpit — CLI of the project cockpit (Phase 1 + Phase 2 `dash`).
// Spec: planning/cockpit-design.md §4 §8, github.com/earlyadopter/ai-foundation/issues/10
// Shared state layer: ./state.ts. Dashboard server: ./server.ts.

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AUDIT_FILE, OPEN_TARGETS, REGISTRY_FILE,
  type Project, type Tier,
  agentState, allProjects, attentionItems, audit, claudeCwds, ensureSession, gitState, readFoundation,
  humanAge, loadProject, loadRegistry, localService, openTarget, planStats, portListening,
  readPlan, saveRegistry, sendToWindow, sh, tmuxSessionAlive, tmuxWindows,
} from "./state.ts";
import { readFileSync } from "node:fs";

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
  if (!p.hasConfig) console.log(dim("hint: add a .project-cockpit.yml — template in ai-foundation/foundation/templates/common/"));
}

async function cmdList(): Promise<void> {
  const projects = allProjects();
  if (projects.length === 0) die("no projects registered — run `cockpit add <path>` first");
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
  rows.sort((a, b) => (b.attention.length ? 1 : 0) - (a.attention.length ? 1 : 0) || a.p.name.localeCompare(b.p.name));
  const nameW = Math.max(...rows.map((r) => r.p.name.length)) + 2;
  const branchW = Math.max(...rows.map((r) => (r.git.branch || "-").length)) + 2;
  for (const r of rows) {
    const dot = r.attention.length ? yellow("●") : green("●");
    const sess = r.session ? cyan("tmux") : dim("    ");
    const dev = r.devUp === null ? dim("     ") : r.devUp ? green(`:${localService(r.p)!.port}`) : dim(`:${localService(r.p)!.port}✗`);
    const ag = r.agent.state === "working" ? cyan("agent✳")
      : r.agent.state === "waiting" ? yellow("agent✋")
      : r.agent.state === "idle" ? dim("agent…") : dim("      ");
    const att = r.attention.length ? yellow(r.attention.join(", ")) : dim("clean");
    console.log(`${dot} ${bold(r.p.name.padEnd(nameW))}${(r.git.branch || "-").padEnd(branchW)}${sess}  ${dev.padEnd(isTTY ? 14 : 6)} ${ag.padEnd(isTTY ? 15 : 7)} ${att}`);
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
  console.log(`\n  ${bold("agent")} ${agentLabel}${agent.state !== "none" ? dim(` — ${agent.detail}${agent.ageSec !== null ? `, last activity ${humanAge(agent.ageSec)}` : ""}${agent.procs > 1 ? `, ${agent.procs} instances` : ""}`) : ""}`);

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

async function cmdGo(query: string, cc = false): Promise<void> {
  const p = findProject(query);
  const created = await ensureSession(p).catch((e) => die(String(e.message ?? e)));
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
  const r = sh("launchctl", ["bootstrap", `gui/${uid}`, PLIST_PATH]);
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

function cmdAudit(): void {
  if (!existsSync(AUDIT_FILE)) {
    console.log(dim("audit log is empty"));
    return;
  }
  process.stdout.write(readFileSync(AUDIT_FILE, "utf8"));
}

function help(): void {
  console.log(`${bold("cockpit")} — local project cockpit

  cockpit list                      all projects, one status line each
  cockpit status <project>          full picture: git, tmux, services, actions
  cockpit go <project>              attach-or-create the project tmux session
                                    (native iTerm2 tabs by default in iTerm2;
                                     --no-cc for classic tmux UI, --cc to force)
  cockpit open <project> <target>   ${OPEN_TARGETS.join(" | ")}
  cockpit run <project> <action>    run a declared action (tier-enforced, audited)
  cockpit dash [port]               start the dashboard (default http://localhost:4400)
  cockpit dash --host <ip>          bind beyond localhost (e.g. a Tailscale IP);
                                    enforces bearer-token auth — docs/remote-access.md
  cockpit dash --token <t>          override the token (default: ~/.project-cockpit/token)
  cockpit dash --install            auto-start the dashboard at login (launchd,
                                    combines with --host)
  cockpit dash --uninstall          remove the login auto-start
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
  case "dash": {
    const port = Number(args.find((a) => /^\d+$/.test(a))) || 4400;
    const flagVal = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const host = flagVal("--host");
    const token = flagVal("--token");
    if (args.includes("--install")) { installLaunchAgent(port, host); break; }
    if (args.includes("--uninstall")) { uninstallLaunchAgent(); break; }
    const { startServer } = await import("./server.ts");
    startServer(port, { host, token });
    // Only auto-open when the plain localhost URL will actually work (no token
    // in play) — otherwise the server has printed the tokened login URL.
    const tokenInPlay = token || process.env.COCKPIT_TOKEN || (host && !["127.0.0.1", "localhost", "::1"].includes(host));
    if (process.stdout.isTTY && !tokenInPlay) sh("open", [`http://localhost:${port}`]);
    break;
  }
  case "add": cmdAdd(args[0]); break;
  case "audit": cmdAudit(); break;
  case undefined: case "help": case "-h": case "--help": help(); break;
  default: die(`unknown command "${cmd}" — try: cockpit help`);
}
