// plan.md / portfolio.md writes are the part of the cockpit that edits user files, so
// each one is checked against a fixture: the exact resulting text, i.e. "only the
// targeted lines changed". Runs in a throwaway COCKPIT_DIR. `bun test`.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "cockpit-test-"));
process.env.COCKPIT_DIR = join(sandbox, "state");
const state = await import("../src/state.ts");
const home = await import("../src/home.ts");

const PLAN = `# Plan

## Direction

- [ ] open question?

## Features

### A

prose stays put

- [x] a1 done (2026-01-01)
- [ ] a2
- [ ] a3
- [ ] a4

### B

- [ ] b1
`;

let root: string;
let p: ReturnType<typeof state.loadProject>;
const plan = () => readFileSync(join(root, "plan.md"), "utf8");
const lines = () => plan().split("\n");

beforeEach(() => {
  rmSync(home.PORTFOLIO_FILE, { force: true }); // each test starts from the template
  root = mkdtempSync(join(sandbox, "proj-"));
  writeFileSync(join(root, "plan.md"), PLAN);
  p = state.loadProject(root);
});

describe("plan.md writes", () => {
  test("parser records line numbers and ideas", () => {
    writeFileSync(join(root, "plan.md"), PLAN.replace("## Features", "## Ideas\n\n- an idea\n- done one → planned as \"X\" (2026-01-02)\n\n## Features"));
    const pl = state.readPlan(p)!;
    expect(pl.ideas.map((i) => [i.text.slice(0, 7), i.planned])).toEqual([["an idea", false], ["done on", true]]);
    expect(lines()[pl.features[0].tickets[1].line]).toBe("- [ ] a2");
  });

  test("addTicket appends after the feature's last ticket", () => {
    home.addTicket(p, "A", "a5");
    expect(plan()).toBe(PLAN.replace("- [ ] a4\n", "- [ ] a4\n- [ ] a5\n"));
  });

  test("addTicket creates a missing feature at the end of ## Features", () => {
    home.addTicket(p, "C", "c1");
    expect(plan()).toBe(PLAN.replace("- [ ] b1\n", "- [ ] b1\n\n### C\n\n- [ ] c1\n"));
  });

  test("addTicket collapses newlines — one input can't add a heading", () => {
    home.addTicket(p, "B", "x\n## Direction\n- [ ] y");
    expect(lines().filter((l) => l.startsWith("## Direction"))).toHaveLength(1);
    expect(plan()).toContain("- [ ] x ## Direction - [ ] y\n");
  });

  test("checkTicket changes one line and stamps the date once", () => {
    home.checkTicket(p, "A", "a3", true);
    const after = lines();
    const before = PLAN.split("\n");
    const changed = after.map((l, i) => (l !== before[i] ? i : -1)).filter((i) => i >= 0);
    expect(changed).toHaveLength(1);
    expect(after[changed[0]]).toMatch(/^- \[x\] a3 \(\d{4}-\d{2}-\d{2}\)$/);
  });

  test("moveTicket: up, down, to end — always one line moved", () => {
    const order = () => lines().filter((l) => /^- \[ \] a/.test(l)).map((l) => l.slice(6));
    home.moveTicket(p, "A", "a4", "a2");
    expect(order()).toEqual(["a4", "a2", "a3"]);
    home.moveTicket(p, "A", "a4", "a3");
    expect(order()).toEqual(["a2", "a4", "a3"]);
    home.moveTicket(p, "A", "a2", null);
    expect(order()).toEqual(["a4", "a3", "a2"]);
    // everything that isn't an A ticket is untouched, in place
    expect(lines().filter((l) => !/^- \[ \] a/.test(l))).toEqual(PLAN.split("\n").filter((l) => !/^- \[ \] a/.test(l)));
  });

  test("moveTicket refuses a target in another feature", () => {
    expect(home.moveTicket(p, "A", "a2", "b1").ok).toBe(false);
    expect(plan()).toBe(PLAN);
  });

  test("addIdeas creates ## Ideas before ## Features, then appends to it", () => {
    home.addIdeas(p, ["- first", "  "]);
    home.addIdeas(p, ["second"]);
    expect(plan()).toBe(PLAN.replace("## Features", "## Ideas\n\n- first\n- second\n\n## Features"));
  });

  test("planFeature writes tickets and annotates the idea instead of deleting it", () => {
    home.addIdeas(p, ["idea one"]);
    home.planFeature(p, "Idea One", ["t1", "- [ ] t2"], "idea one");
    expect(plan()).toMatch(/- idea one → planned as "Idea One" \(\d{4}-\d{2}-\d{2}\)\n/);
    expect(plan()).toContain("### Idea One\n\n- [ ] t1\n- [ ] t2\n");
  });
});

describe("review findings (2026-10-18)", () => {
  test("CRLF plan.md stays CRLF through check / add / move", () => {
    writeFileSync(join(root, "plan.md"), PLAN.replace(/\n/g, "\r\n"));
    home.checkTicket(p, "A", "a2", true);
    home.addTicket(p, "A", "a5");
    home.moveTicket(p, "A", "a4", "a3");
    const raw = plan();
    expect(raw.split("\r\n").join("").includes("\n")).toBe(false);
    expect(raw).toMatch(/- \[x\] a2 \(\d{4}-\d{2}-\d{2}\)\r\n/);
    expect(raw).toContain("- [ ] a4\r\n- [ ] a3\r\n- [ ] a5\r\n");
  });

  test("a ticket keeps its indented notes on add and move", () => {
    writeFileSync(join(root, "plan.md"), PLAN.replace("- [ ] a3\n", "- [ ] a3\n  - note for a3\n"));
    home.addTicket(p, "A", "a5");
    home.moveTicket(p, "A", "a3", null);
    home.moveTicket(p, "A", "a5", "a2");
    const a = lines().filter((l) => /^(- \[ \] a|  - note)/.test(l));
    expect(a).toEqual(["- [ ] a5", "- [ ] a2", "- [ ] a4", "- [ ] a3", "  - note for a3"]);
  });

  test("negative bucket index can't write above the title", () => {
    const r = join(sandbox, "neg"); mkdirSync(r, { recursive: true });
    home.setBucket(state.loadProject(r), "Later", -1);
    const text = readFileSync(home.PORTFOLIO_FILE, "utf8");
    expect(text.startsWith("# Portfolio")).toBe(true);
    expect(home.readPortfolio().buckets.Later).toContain("neg");
  });

  test("'<!--' inside a queue entry doesn't hide the entries after it", () => {
    home.queueAdd("x", "a <!-- b", false);
    home.queueAdd("x", "c", false);
    expect(home.readPortfolio().queue.map((q) => q.text)).toEqual(expect.arrayContaining(["a <!-- b", "c"]));
  });
});

describe("portfolio.md", () => {
  test("buckets: Now caps at 3, moves keep one entry, queue ops renumber", () => {
    const mk = (n: string) => { const r = join(sandbox, n); mkdirSync(r, { recursive: true }); return state.loadProject(r); };
    const [a, b, c, d] = ["pa", "pb", "pc", "pd"].map(mk);
    for (const x of [a, b, c]) expect(home.setBucket(x, "Now").ok).toBe(true);
    expect(home.setBucket(d, "Now").ok).toBe(false);
    home.setBucket(a, "Later");
    home.setBucket(d, "Now", 0);
    const pf = home.readPortfolio();
    expect(pf.buckets.Now).toEqual(["pd", "pb", "pc"]);
    expect(pf.buckets.Later).toEqual(["pa"]);

    home.queueAdd("pa", "t1", false);
    home.queueAdd("pb", "t2", true);
    home.queueMove("pb", "t2", 0);
    expect(home.readPortfolio().queue.map((q) => [q.project, q.text, q.you])).toEqual([["pb", "t2", true], ["pa", "t1", false]]);
    home.queueRemove("pb", "t2");
    const text = readFileSync(home.PORTFOLIO_FILE, "utf8");
    expect(text).toContain("## Up next\n\n1. pa :: t1\n");
  });

  test("deriveStatus", () => {
    const base = { agent: "none", openQuestions: 0, openTickets: 2, ticketsTotal: 5, hasPlan: true, activitySec: 3600, bucket: null };
    expect(home.deriveStatus({ ...base, openQuestions: 1 })).toBe("needs-you");
    expect(home.deriveStatus({ ...base, agent: "working" })).toBe("running");
    expect(home.deriveStatus({ ...base, bucket: "Parked" })).toBe("parked");
    expect(home.deriveStatus(base)).toBe("active");
    expect(home.deriveStatus({ ...base, activitySec: 10 * 86400 })).toBe("cooling");
    expect(home.deriveStatus({ ...base, activitySec: 40 * 86400 })).toBe("dormant");
    expect(home.deriveStatus({ ...base, openTickets: 0, activitySec: 10 * 86400 })).toBe("done");
    expect(home.deriveStatus({ ...base, openTickets: 0 })).toBe("unplanned");
  });
});
