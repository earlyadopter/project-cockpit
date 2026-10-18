// home.ts — the cross-project layer behind the home screen (redesign phases B–F):
// roots & discovery, content projects, ABOUT.md, portfolio.md, derived statuses,
// work items, and surgical plan.md writes (add / check / move tickets, ideas).
// Same invariants as state.ts: nothing is cached — every call reads the files;
// plan.md writes touch only the lines they target (spec v1.1, ai-foundation).

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import {
  COCKPIT_DIR, REGISTRY_FILE, type Plan, type Project, loadRegistry, readPlan, shA,
} from "./state.ts";

const today = () => new Date().toISOString().slice(0, 10);

// One line of user text going into a markdown file: no newlines (one input must
// not be able to inject a heading or a second item), bounded length.
export function oneLine(s: unknown, max = 400): string | null {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t && t.length <= max ? t : null;
}

// Files are edited as lines and written back with the line ending they came with
// (a CRLF plan.md stays CRLF; a missing trailing newline stays missing).
export function readLines(path: string): { lines: string[]; eol: string } {
  const text = readFileSync(path, "utf8");
  return { lines: text.split(/\r?\n/), eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

// A ticket as typed or pasted: checkbox/bullet markers stripped, one line.
export function cleanTicket(s: unknown): string | null {
  return oneLine(String(s ?? "").replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, ""));
}

// A ticket "owns" the indented, non-blank lines under it (notes, sub-bullets):
// inserts go after them and moves carry them along.
function spanEnd(lines: string[], i: number): number {
  let j = i + 1;
  while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
  return j;
}

export function expandHome(p: string): string {
  return resolve(p.startsWith("~") ? homedir() + p.slice(1) : p).replace(/\/$/, "");
}

// ---------- registry: roots & ignored (the projects list itself lives in state.ts) ----------
interface RegistryDoc { projects?: string[]; roots?: string[]; ignored?: string[] }

function readDoc(): RegistryDoc {
  if (!existsSync(REGISTRY_FILE)) return {};
  return (yamlLoad(readFileSync(REGISTRY_FILE, "utf8")) as RegistryDoc | null) ?? {};
}
function writeDoc(doc: RegistryDoc): void {
  mkdirSync(COCKPIT_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, yamlDump({ projects: doc.projects ?? [], ...doc }));
}

// Roots = folders whose sub-folders are candidate projects. Explicit ones come from
// `roots:`; the parent of every registered project is an implied root, so an existing
// registry gets discovery with zero setup.
export function effectiveRoots(): { path: string; explicit: boolean }[] {
  const explicit = (readDoc().roots ?? []).map((r) => r.replace(/\/$/, ""));
  const implied = loadRegistry().map((p) => dirname(p.replace(/\/$/, "")));
  const seen = new Set<string>();
  const out: { path: string; explicit: boolean }[] = [];
  for (const [path, isExplicit] of [...explicit.map((p) => [p, true] as const), ...implied.map((p) => [p, false] as const)]) {
    if (seen.has(path) || !isDir(path)) continue;
    seen.add(path);
    out.push({ path, explicit: isExplicit });
  }
  return out;
}

export function setRoot(path: string, add: boolean): { ok: boolean; path?: string; error?: string } {
  const full = expandHome(path);
  if (add && !isDir(full)) return { ok: false, error: `no such directory: ${full}` };
  const doc = readDoc();
  const roots = new Set(doc.roots ?? []);
  add ? roots.add(full) : roots.delete(full);
  doc.roots = [...roots];
  writeDoc(doc);
  return { ok: true, path: full };
}

export function setIgnored(path: string, ignore: boolean): { ok: boolean; error?: string } {
  const full = expandHome(path);
  if (!underARoot(full)) return { ok: false, error: "not a sub-folder of a known root" };
  const doc = readDoc();
  const ign = new Set(doc.ignored ?? []);
  ignore ? ign.add(full) : ign.delete(full);
  doc.ignored = [...ign];
  writeDoc(doc);
  return { ok: true };
}

export function underARoot(full: string): boolean {
  return effectiveRoots().some((r) => dirname(full) === r.path);
}

// ---------- discovery & project kinds ----------
export type Kind = "code" | "content" | "folder";
const CODE_MARKERS = [".git", "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "Gemfile", ".project-cockpit.yml", "Makefile"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".cache", "vendor", "target"]);

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// code = has a repo or a build manifest; content = markdown, no code; folder = only
// sub-folders (a candidate root, e.g. Knowledge-share). null = nothing worth showing.
export function folderKind(dir: string): Kind | null {
  if (CODE_MARKERS.some((m) => existsSync(join(dir, m)))) return "code";
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return null; }
  if (entries.some((e) => e.toLowerCase().endsWith(".md"))) return "content";
  if (entries.some((e) => !e.startsWith(".") && !SKIP_DIRS.has(e) && isDir(join(dir, e)))) return "folder";
  return null;
}

export function projectKind(p: Project): "code" | "content" {
  return folderKind(p.root) === "content" ? "content" : "code";
}

export interface Candidate { path: string; name: string; kind: Kind; ignored: boolean; tagline: string }

export function discover(): { root: string; explicit: boolean; folders: Candidate[] }[] {
  const registered = new Set(loadRegistry().map((p) => p.replace(/\/$/, "")));
  const ignored = new Set(readDoc().ignored ?? []);
  return effectiveRoots().map((r) => {
    const folders: Candidate[] = [];
    let entries: string[] = [];
    try { entries = readdirSync(r.path); } catch { /* unreadable root: empty */ }
    for (const e of entries) {
      if (e.startsWith(".") || SKIP_DIRS.has(e)) continue;
      const full = join(r.path, e);
      // lstat: never follow a symlink out of the root
      try { if (!lstatSync(full).isDirectory()) continue; } catch { continue; }
      if (registered.has(full)) continue;
      const kind = folderKind(full);
      if (!kind) continue;
      folders.push({ path: full, name: e, kind, ignored: ignored.has(full), tagline: readAbout(full)?.title ?? "" });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    return { root: r.path, explicit: r.explicit, folders };
  });
}

// Last sign of life, epoch seconds: newest of last commit and uncommitted-file mtimes
// for code; newest markdown mtime (bounded walk) for content.
export async function lastActivity(p: Project, dirty: string[]): Promise<number | null> {
  let newest = 0;
  if (existsSync(join(p.root, ".git"))) {
    const r = await shA("git", ["-C", p.root, "log", "-1", "--format=%ct"]);
    if (r.ok && r.out) newest = Number(r.out) || 0;
    for (const l of dirty.slice(0, 30)) {
      const rel = l.trim().replace(/^\S{1,2}\s+/, "").replace(/^"|"$/g, "").split(" -> ").pop()!;
      if (rel === "ABOUT.md") continue; // describing a project isn't working on it
      try { newest = Math.max(newest, Math.floor(statSync(join(p.root, rel)).mtimeMs / 1000)); } catch { /* deleted */ }
    }
    return newest || null;
  }
  let budget = 3000;
  const walk = (dir: string, depth: number) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (--budget < 0) return;
      if (e.startsWith(".") || SKIP_DIRS.has(e)) continue;
      const full = join(dir, e);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3) walk(full, depth + 1); }
      else if (e.toLowerCase().endsWith(".md") && !(depth === 0 && e === "ABOUT.md")) newest = Math.max(newest, Math.floor(st.mtimeMs / 1000));
    }
  };
  walk(p.root, 0);
  return newest || null;
}

// ---------- ABOUT.md: heading = tagline, first paragraph = description ----------
export interface About { title: string; description: string; path: string }
const ABOUT_NOTE = "<!-- ABOUT.md: the heading is this project's short tagline, the paragraph its description. Read by project-cockpit; edit freely. -->";

export function readAbout(root: string): About | null {
  const path = join(root, "ABOUT.md");
  if (!existsSync(path)) return null;
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const h = lines.findIndex((l) => /^#\s+/.test(l));
  const title = h >= 0 ? lines[h].replace(/^#\s+/, "").trim() : "";
  const para: string[] = [];
  for (const l of lines.slice(h + 1)) {
    if (/^#/.test(l)) break;
    if (!l.trim()) { if (para.length) break; continue; }
    para.push(l.trim());
  }
  return { title, description: para.join(" "), path };
}

// Rewrites the heading and paragraph; keeps any trailing comment (provenance note).
export function writeAbout(root: string, title: string, description: string): void {
  const path = join(root, "ABOUT.md");
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  const note = old.match(/<!--[\s\S]*?-->/)?.[0] ?? ABOUT_NOTE;
  writeFileSync(path, `# ${title}\n\n${description ? description + "\n\n" : ""}${note}\n`);
}

// A starting point for a missing ABOUT.md, from the README or package.json. Never written unasked.
export function draftAbout(root: string): { title: string; description: string; source: string } {
  for (const f of ["README.md", "readme.md", "Readme.md"]) {
    const full = join(root, f);
    if (!existsSync(full)) continue;
    const lines = readFileSync(full, "utf8").replace(/<!--[\s\S]*?-->/g, "").split("\n");
    const h = lines.findIndex((l) => /^#\s+/.test(l));
    const para: string[] = [];
    for (const l of lines.slice(h + 1)) {
      if (/^#|^!\[|^\[!\[|^```|^\|/.test(l)) { if (para.length) break; continue; }
      if (!l.trim()) { if (para.length) break; continue; }
      para.push(l.trim());
    }
    return { title: h >= 0 ? lines[h].replace(/^#\s+/, "").trim() : basename(root), description: para.join(" ").slice(0, 600), source: f };
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg.description) return { title: pkg.description, description: "", source: "package.json" };
  } catch { /* none */ }
  return { title: basename(root), description: "", source: "folder name" };
}

// ---------- portfolio.md: cross-project priority ----------
// ## Now (max 3) / ## Next / ## Later / ## Parked hold `- <project>` lines, order =
// priority. ## Up next holds `N. <project> :: <ticket text>` (+ ` @you`), the global
// queue. `Reviewed: YYYY-MM-DD` records the last weekly review.
export const PORTFOLIO_FILE = join(COCKPIT_DIR, "portfolio.md");
export const BUCKETS = ["Now", "Next", "Later", "Parked"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const NOW_MAX = 3;

export interface QueueItem { project: string; text: string; you: boolean; line: number }
export interface Portfolio {
  exists: boolean; reviewed: string | null;
  buckets: Record<Bucket, string[]>; queue: QueueItem[];
}

const PORTFOLIO_TEMPLATE = `# Portfolio

Reviewed: never

<!--
Cross-project priority, read and edited by project-cockpit (drag in the dashboard,
or edit here). One project per line by its cockpit name; order inside a bucket =
priority. Now holds at most ${NOW_MAX}. Up next is the cross-project ticket queue:
\`project :: ticket text\` (the text must match an open plan.md ticket), plus \`@you\`
for tasks only you can do.
-->

## Now

## Next

## Later

## Parked

## Up next
`;

let portfolioEol = "\n";
function readPortfolioLines(): string[] {
  if (!existsSync(PORTFOLIO_FILE)) { portfolioEol = "\n"; return PORTFOLIO_TEMPLATE.split("\n"); }
  const r = readLines(PORTFOLIO_FILE);
  portfolioEol = r.eol;
  return r.lines;
}

export function readPortfolio(): Portfolio {
  const pf: Portfolio = { exists: existsSync(PORTFOLIO_FILE), reviewed: null, buckets: { Now: [], Next: [], Later: [], Parked: [] }, queue: [] };
  let section = "";
  let inComment = false;
  readPortfolioLines().forEach((l, i) => {
    // comments are blocks that start a line; "<!--" inside an entry's text is just text
    if (!inComment && /^\s*<!--/.test(l)) inComment = true;
    if (inComment) { if (l.includes("-->")) inComment = false; return; }
    const rv = l.match(/^Reviewed:\s*(\d{4}-\d{2}-\d{2})/);
    if (rv) { pf.reviewed = rv[1]; return; }
    const h = l.match(/^##\s+(.+)/);
    if (h) { section = h[1].trim().toLowerCase(); return; }
    const b = BUCKETS.find((x) => x.toLowerCase() === section);
    if (b) {
      const m = l.match(/^[-*]\s+(.+)/);
      if (m) pf.buckets[b].push(m[1].trim());
    } else if (section === "up next") {
      const m = l.match(/^(?:\d+\.|[-*])\s+(.+?)\s+::\s+(.+)$/);
      if (m) {
        const you = /\s@you\s*$/.test(m[2]);
        pf.queue.push({ project: m[1].trim(), text: m[2].replace(/\s@you\s*$/, "").trim(), you, line: i });
      }
    }
  });
  return pf;
}

// A portfolio entry names a project by cockpit name, folder name, or trailing path.
export function entryMatches(entry: string, p: Project): boolean {
  const e = entry.replace(/\/$/, "");
  return e === p.name || e === basename(p.root) || p.root.endsWith("/" + e);
}

export function bucketOf(p: Project, pf: Portfolio): Bucket | null {
  return BUCKETS.find((b) => pf.buckets[b].some((e) => entryMatches(e, p))) ?? null;
}

function sectionRange(lines: string[], title: string): [number, number] | null {
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${title}\\s*$`, "i").test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return [start, end];
}

function savePortfolio(lines: string[]): void {
  mkdirSync(COCKPIT_DIR, { recursive: true });
  writeFileSync(PORTFOLIO_FILE, lines.join(portfolioEol).replace(/(\r?\n)*$/, portfolioEol));
}

// Item lines (by matcher) inside a section, in file order.
function itemLines(lines: string[], range: [number, number], re: RegExp): number[] {
  const out: number[] = [];
  for (let i = range[0] + 1; i < range[1]; i++) if (re.test(lines[i])) out.push(i);
  return out;
}

// Insert `text` as the index-th item of a section (append when index is past the end).
function insertItem(lines: string[], title: string, re: RegExp, index: number, text: string): void {
  let range = sectionRange(lines, title);
  if (!range) {
    // missing section: add it before "## Up next" (buckets) or at the end
    const upAt = lines.findIndex((l) => /^##\s+Up next\s*$/i.test(l));
    const at = title.toLowerCase() !== "up next" && upAt >= 0 ? upAt : lines.length;
    lines.splice(at, 0, `## ${title}`, "", "");
    range = sectionRange(lines, title)!;
  }
  const items = itemLines(lines, range, re);
  index = Math.max(0, Number.isFinite(index) ? index : items.length);
  if (index < items.length) { lines.splice(items[index], 0, text); return; }
  if (items.length) { lines.splice(items[items.length - 1] + 1, 0, text); return; }
  // empty section: after the heading and one blank line
  lines.splice(range[0] + 1, 0, "", text);
  if (lines[range[0] + 3] !== undefined && lines[range[0] + 3].trim() !== "") lines.splice(range[0] + 3, 0, "");
}

const BUCKET_ITEM = /^[-*]\s+\S/;
const QUEUE_ITEM = /^(?:\d+\.|[-*])\s+.+\s+::\s+/;

export function setBucket(p: Project, bucket: Bucket | null, index = Infinity): { ok: boolean; error?: string } {
  const lines = readPortfolioLines();
  const pf = readPortfolio();
  const current = bucketOf(p, pf);
  if (bucket === "Now" && current !== "Now" && pf.buckets.Now.length >= NOW_MAX)
    return { ok: false, error: `Now holds at most ${NOW_MAX} — move one of ${pf.buckets.Now.join(", ")} out first` };
  // keep the user's spelling of the entry if it exists
  let entry = p.name;
  for (const b of BUCKETS) {
    const range = sectionRange(lines, b);
    if (!range) continue;
    for (const i of itemLines(lines, range, BUCKET_ITEM)) {
      const name = lines[i].replace(/^[-*]\s+/, "").trim();
      if (entryMatches(name, p)) { entry = name; lines.splice(i, 1); break; }
    }
  }
  if (bucket) insertItem(lines, bucket, BUCKET_ITEM, index, `- ${entry}`);
  savePortfolio(lines);
  return { ok: true };
}

function renumberQueue(lines: string[]): void {
  const range = sectionRange(lines, "Up next");
  if (!range) return;
  itemLines(lines, range, QUEUE_ITEM).forEach((i, n) => { lines[i] = lines[i].replace(/^(?:\d+\.|[-*])/, `${n + 1}.`); });
}

export function queueAdd(project: string, text: string, you: boolean, index = Infinity): void {
  const lines = readPortfolioLines();
  insertItem(lines, "Up next", QUEUE_ITEM, index, `1. ${project} :: ${text}${you ? " @you" : ""}`);
  renumberQueue(lines);
  savePortfolio(lines);
}

// Queue ops address an item by project + text (not index), so a stale page can't hit the wrong line.
function queueLine(lines: string[], project: string, text: string): number {
  const pf = readPortfolio();
  return pf.queue.find((q) => q.project === project && q.text === text)?.line ?? -1;
}

export function queueRemove(project: string, text: string): boolean {
  const lines = readPortfolioLines();
  const i = queueLine(lines, project, text);
  if (i < 0) return false;
  lines.splice(i, 1);
  renumberQueue(lines);
  savePortfolio(lines);
  return true;
}

export function queueMove(project: string, text: string, index: number): boolean {
  const lines = readPortfolioLines();
  const i = queueLine(lines, project, text);
  if (i < 0) return false;
  const [line] = lines.splice(i, 1);
  insertItem(lines, "Up next", QUEUE_ITEM, index, line);
  renumberQueue(lines);
  savePortfolio(lines);
  return true;
}

export function markReviewed(): void {
  const lines = readPortfolioLines();
  const i = lines.findIndex((l) => /^Reviewed:/.test(l));
  if (i >= 0) lines[i] = `Reviewed: ${today()}`;
  else lines.splice(1, 0, "", `Reviewed: ${today()}`);
  savePortfolio(lines);
}

// The queue entry's text must still name an open ticket: equal, or a prefix of it
// (tickets grow "→ outcome (date)" suffixes as they are worked).
export function findOpenTicket(plan: Plan | null, text: string): { feature: string; text: string } | null {
  for (const f of plan?.features ?? []) {
    const t = f.tickets.find((x) => !x.done && (x.text === text || x.text.startsWith(text)));
    if (t) return { feature: f.name, text: t.text };
  }
  return null;
}

// ---------- derived status ----------
export type Status = "needs-you" | "running" | "active" | "cooling" | "dormant" | "unplanned" | "done" | "parked";
export const STATUS_ORDER: Status[] = ["needs-you", "running", "active", "cooling", "unplanned", "dormant", "done", "parked"];
const DAY = 86_400;

export function deriveStatus(s: {
  agent: string; openQuestions: number; openTickets: number; ticketsTotal: number; hasPlan: boolean;
  activitySec: number | null; bucket: Bucket | null;
}): Status {
  if (s.agent === "waiting" || s.openQuestions > 0) return "needs-you";
  if (s.agent === "working") return "running";
  if (s.bucket === "Parked") return "parked";
  const idle = s.activitySec ?? Infinity;
  if (s.openTickets === 0) {
    if (s.hasPlan && s.ticketsTotal > 0 && idle >= 7 * DAY) return "done";
    return idle < 30 * DAY ? "unplanned" : "dormant";
  }
  return idle < 7 * DAY ? "active" : idle < 30 * DAY ? "cooling" : "dormant";
}

// ---------- plan.md writes (surgical) ----------
function planLines(p: Project): { full: string; lines: string[]; plan: Plan; save: (lines: string[]) => void } | null {
  const plan = readPlan(p);
  if (!plan) return null;
  const full = join(p.root, plan.path);
  const { lines, eol } = readLines(full);
  return { full, lines, plan, save: (ls) => writeFileSync(full, ls.join(eol)) };
}

const NEW_PLAN = (feature: string, ticket: string) => `# Plan\n\n## Direction\n\n## Features\n\n### ${feature}\n\n- [ ] ${ticket}\n`;

// Last non-blank line of a feature block (heading included), before the next heading.
function blockEnd(lines: string[], headingLine: number): number {
  let end = headingLine;
  for (let i = headingLine + 1; i < lines.length && !/^#{1,3}\s/.test(lines[i]); i++) if (lines[i].trim()) end = i;
  return end;
}

export function addTicket(p: Project, feature: string, text: string): { ok: boolean; error?: string } {
  const t = cleanTicket(text);
  const f = oneLine(feature, 120);
  if (!t || !f) return { ok: false, error: "ticket and feature must be one line (ticket ≤ 400 chars, feature ≤ 120)" };
  const pl = planLines(p);
  if (!pl) { writeFileSync(join(p.root, "plan.md"), NEW_PLAN(f, t)); return { ok: true }; }
  const { lines, plan } = pl;
  const feat = plan.features.find((x) => x.name === f);
  if (feat) {
    const at = feat.tickets.length ? spanEnd(lines, feat.tickets[feat.tickets.length - 1].line) : blockEnd(lines, feat.line) + 1;
    if (feat.tickets.length) lines.splice(at, 0, `- [ ] ${t}`);
    else lines.splice(at, 0, "", `- [ ] ${t}`);
  } else {
    // new feature block at the end of ## Features (or of the file)
    const fi = lines.findIndex((l) => /^##(?!#)\s+Features/i.test(l));
    let at = lines.length;
    if (fi >= 0) { at = fi + 1; while (at < lines.length && !/^##(?!#)\s/.test(lines[at])) at++; }
    while (at > 0 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, "", `### ${f}`, "", `- [ ] ${t}`);
  }
  pl.save(lines);
  return { ok: true };
}

export function checkTicket(p: Project, feature: string, text: string, done: boolean): { ok: boolean; error?: string } {
  const pl = planLines(p);
  if (!pl) return { ok: false, error: "no plan.md" };
  const t = pl.plan.features.find((f) => f.name === feature)?.tickets.find((x) => x.text === text);
  if (!t) return { ok: false, error: "ticket not found (plan.md changed since last refresh?)" };
  if (t.done === done) return { ok: true };
  const line = pl.lines[t.line];
  pl.lines[t.line] = done
    ? line.replace(/\[ \]/, "[x]") + (/\(\d{4}-\d{2}-\d{2}\)\s*$/.test(line) ? "" : ` (${today()})`)
    : line.replace(/\[[xX]\]/, "[ ]");
  pl.save(pl.lines);
  return { ok: true };
}

// Priority = order of open tickets inside one feature (spec v1.1). Moves exactly one
// line: before the `before` ticket, or after the feature's last ticket when null.
export function moveTicket(p: Project, feature: string, text: string, before: string | null): { ok: boolean; error?: string } {
  const pl = planLines(p);
  if (!pl) return { ok: false, error: "no plan.md" };
  const feat = pl.plan.features.find((f) => f.name === feature);
  const t = feat?.tickets.find((x) => x.text === text && !x.done);
  if (!feat || !t) return { ok: false, error: "ticket not found (plan.md changed since last refresh?)" };
  const target = before === null ? null : feat.tickets.find((x) => x.text === before);
  if (before !== null && !target) return { ok: false, error: "target ticket not in the same feature" };
  if (target?.line === t.line) return { ok: true };
  const { lines } = pl;
  const end = spanEnd(lines, t.line);
  const n = end - t.line;
  const last = feat.tickets[feat.tickets.length - 1].line;
  if (!target && last === t.line) return { ok: true };
  // insertion point in the original numbering, then shifted for the removed block
  const at0 = target ? target.line : spanEnd(lines, last);
  const moved = lines.splice(t.line, n);
  lines.splice(at0 > t.line ? at0 - n : at0, 0, ...moved);
  pl.save(lines);
  return { ok: true };
}

export function addIdeas(p: Project, ideas: string[]): { ok: boolean; added: number; error?: string } {
  const clean = ideas.map((i) => oneLine(i.replace(/^\s*[-*]\s+/, ""), 400)).filter((x): x is string => !!x);
  if (!clean.length) return { ok: false, added: 0, error: "no ideas (one per line, ≤ 400 chars each)" };
  let pl = planLines(p);
  if (!pl) { writeFileSync(join(p.root, "plan.md"), "# Plan\n\n## Direction\n\n## Ideas\n\n## Features\n"); pl = planLines(p)!; }
  const { lines, plan } = pl;
  const bullets = clean.map((i) => `- ${i}`);
  if (plan.ideasLine === null) {
    // ## Ideas sits before ## Features (reading order: direction, ideas, work)
    const fi = lines.findIndex((l) => /^##(?!#)\s+Features/i.test(l));
    const at = fi >= 0 ? fi : lines.length;
    lines.splice(at, 0, "## Ideas", "", ...bullets, "");
  } else {
    const at = plan.ideas.length ? plan.ideas[plan.ideas.length - 1].line + 1 : blockEnd(lines, plan.ideasLine) + 1;
    lines.splice(at, 0, ...(plan.ideas.length ? bullets : ["", ...bullets]));
  }
  pl.save(lines);
  return { ok: true, added: clean.length };
}

// Promote an idea: write the feature + tickets, then annotate the idea line in place
// (never delete it — the Ideas list keeps its history).
export function planFeature(p: Project, feature: string, tickets: string[], idea?: string): { ok: boolean; error?: string } {
  const f = oneLine(feature, 120);
  const given = tickets.filter((t) => t.trim());
  const ts = given.map(cleanTicket).filter((x): x is string => !!x);
  if (!f || !ts.length) return { ok: false, error: "a feature name and at least one ticket are required" };
  if (ts.length < given.length) return { ok: false, error: "every ticket must be one line of at most 400 characters" };
  for (const t of ts) {
    const r = addTicket(p, f, t);
    if (!r.ok) return r;
  }
  if (idea) {
    const pl = planLines(p)!;
    const i = pl.plan.ideas.find((x) => x.text === idea && !x.planned);
    if (i) {
      pl.lines[i.line] = `${pl.lines[i.line]} → planned as "${f}" (${today()})`;
      pl.save(pl.lines);
    }
  }
  return { ok: true };
}

// ---------- headless Claude for Ideate / Plan drafts ----------
// Same path as state.ts generateOptions: `claude -p`, context inlined, no tools, the
// user's own subscription. Output is only shown; nothing is written until confirmed.
export async function askClaude(cwd: string, prompt: string): Promise<{ out?: string; error?: string }> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const r = await promisify(execFile)("claude", ["-p", prompt], {
      cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
    });
    return { out: r.stdout.trim() };
  } catch (e: any) {
    return { error: `claude -p failed: ${String(e?.message ?? e).slice(0, 300)}` };
  }
}

export function extractJson<T>(out: string, open: "[" | "{"): T | null {
  const close = open === "[" ? "]" : "}";
  const s = out.indexOf(open), e = out.lastIndexOf(close);
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(out.slice(s, e + 1)) as T; } catch { return null; }
}

function projectContext(p: Project): string {
  const about = readAbout(p.root);
  const plan = readPlan(p);
  const planText = plan ? readFileSync(join(p.root, plan.path), "utf8").slice(0, 8000) : "(no plan.md yet)";
  let readme = "";
  for (const f of ["README.md", "readme.md"]) if (existsSync(join(p.root, f))) { readme = readFileSync(join(p.root, f), "utf8").slice(0, 3000); break; }
  return `PROJECT: ${p.name}\n${about ? `ABOUT: ${about.title} — ${about.description}\n` : ""}\nPLAN.MD:\n${planText}\n\nREADME (excerpt):\n${readme || "(none)"}`;
}

export async function suggestIdeas(p: Project, steer: string): Promise<{ ideas?: string[]; raw?: string; error?: string }> {
  const prompt = `You are brainstorming next ideas for a project. Read the context, then propose 5-8 concrete, distinct ideas that are NOT already in its plan (features, experiments, improvements, things to cut).${steer ? `\nFocus: ${steer}` : ""}

${projectContext(p)}

Respond with ONLY a JSON array of strings, each one idea in one sentence (max ~20 words). No prose.`;
  const r = await askClaude(p.root, prompt);
  if (r.error) return { error: r.error };
  const ideas = extractJson<string[]>(r.out!, "[");
  return Array.isArray(ideas) && ideas.every((i) => typeof i === "string") ? { ideas } : { raw: r.out!.slice(0, 4000) };
}

export async function draftPlan(p: Project, idea: string): Promise<{ feature?: string; tickets?: string[]; raw?: string; error?: string }> {
  const prompt = `Turn this idea into a feature for the project's plan.md: a short feature name and 3-8 small, concrete, independently checkable tickets in priority order.

IDEA: ${idea}

${projectContext(p)}

Respond with ONLY JSON: {"feature": "<name, max ~6 words>", "tickets": ["<ticket, one line>", ...]}. No prose.`;
  const r = await askClaude(p.root, prompt);
  if (r.error) return { error: r.error };
  const d = extractJson<{ feature: string; tickets: string[] }>(r.out!, "{");
  return d && typeof d.feature === "string" && Array.isArray(d.tickets) ? d : { raw: r.out!.slice(0, 4000) };
}

// ---------- setup state (progressive "next steps" on the home screen) ----------
export function hooksInstalled(): boolean {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    return ["Notification", "Stop", "UserPromptSubmit"].every((ev) =>
      (s.hooks?.[ev] ?? []).some((h: any) => (h.hooks ?? []).some((x: any) => String(x.command ?? "").includes("_hook-event"))));
  } catch { return false; }
}

// "3h ago" / "5d ago" / "4mo ago" — humanAge in state.ts stops at hours, too coarse for activity.
export function ago(sec: number | null): string {
  if (sec === null) return "";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m ago`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 60 * 86_400) return `${Math.round(sec / 86_400)}d ago`;
  return `${Math.round(sec / (30 * 86_400))}mo ago`;
}
