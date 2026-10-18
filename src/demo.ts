// `cockpit demo`: a sandbox with sample projects, so a new user (or a test) can try
// every screen without registering anything real. Everything lives under one folder
// marked with a sentinel file; it is rebuilt on each run and touches nothing else.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SENTINEL = ".cockpit-demo";
const DAY = 86_400;

function git(cwd: string, args: string[], daysAgo = 0) {
  const when = new Date(Date.now() - daysAgo * DAY * 1000).toISOString();
  spawnSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], {
    cwd, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

function project(root: string, files: Record<string, string>, commits?: { msg: string; daysAgo: number }[]) {
  mkdirSync(root, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  if (!commits) return;
  git(root, ["init", "-q", "-b", "main"]);
  for (const c of commits) {
    writeFileSync(join(root, ".demo-log"), `${c.msg}\n`, { flag: "a" });
    git(root, ["add", "-A"], c.daysAgo);
    git(root, ["commit", "-q", "-m", c.msg], c.daysAgo);
  }
}

// Builds <dir>/projects/* and <dir>/state (the demo's COCKPIT_DIR). Returns the state dir.
export function makeDemo(dir: string): string {
  if (existsSync(dir)) {
    if (!existsSync(join(dir, SENTINEL))) throw new Error(`${dir} exists and is not a cockpit demo folder — refusing to touch it`);
    rmSync(dir, { recursive: true, force: true });
  }
  const P = join(dir, "projects"), S = join(dir, "state");
  mkdirSync(P, { recursive: true });
  mkdirSync(S, { recursive: true });
  writeFileSync(join(dir, SENTINEL), "rebuilt by `cockpit demo` on every run\n");

  project(join(P, "storefront"), {
    "ABOUT.md": "# Small online shop for printed zines\n\nA Next.js storefront selling printed zines, with Stripe checkout and a tiny admin page for stock.\n",
    "package.json": `{ "name": "storefront", "description": "zine shop" }\n`,
    "plan.md": `# Plan

## Direction

- [ ] Ship international shipping now, or after the holiday rush?

## Features

### Checkout

- [x] Stripe checkout session (2026-09-02)
- [ ] order confirmation email
- [ ] refund button in admin

### Catalog

- [ ] tag filter on the shop page
- [ ] sold-out badge
`,
  }, [{ msg: "Initial storefront", daysAgo: 20 }, { msg: "Stripe checkout", daysAgo: 3 }, { msg: "Admin stock page", daysAgo: 1 }]);
  writeFileSync(join(P, "storefront", "notes.txt"), "uncommitted scratch\n");

  project(join(P, "field-notes"), {
    "ABOUT.md": "# Notes from bird-watching trips\n\nMarkdown only: one file per trip, meant to be published as a small book later.\n",
    "2026-08-ridge.md": "# Ridge trail\n\nTwo hawks.\n",
    "2026-09-marsh.md": "# Marsh\n\nHerons everywhere.\n",
  });

  project(join(P, "cli-tool"), {
    "ABOUT.md": "# Rename photos by the date they were taken\n\nA small CLI that reads EXIF dates and renames camera files to YYYY-MM-DD_HHMM.\n",
    "Cargo.toml": `[package]\nname = "cli-tool"\n`,
    "plan.md": `# Plan

## Features

### v1

- [x] read EXIF date (2026-07-01)
- [x] dry-run flag (2026-07-02)
- [x] README with examples (2026-07-03)
`,
  }, [{ msg: "v1 done", daysAgo: 45 }]);

  project(join(P, "newsletter"), {
    "plan.md": `# Plan

## Direction

## Ideas

- a yearly "best of" issue
- reader-submitted photos section

## Features

### Issue 12

- [ ] pick the cover story
- [ ] draft the intro
`,
    "issue-11.md": "# Issue 11\n",
  }, [{ msg: "Issue 11 sent", daysAgo: 12 }]);

  project(join(P, "experiments"), { "a/README.md": "# try a\n", "b/README.md": "# try b\n" });
  project(join(P, "old-blog"), { "README.md": "# Old blog\n\nPosts from 2019, kept for reference.\n" }, [{ msg: "archive", daysAgo: 400 }]);

  const reg = ["storefront", "field-notes", "cli-tool", "newsletter"].map((n) => `  - ${join(P, n)}`).join("\n");
  writeFileSync(join(S, "registry.yml"), `projects:\n${reg}\n`);
  writeFileSync(join(S, "portfolio.md"), `# Portfolio

Reviewed: ${new Date(Date.now() - 9 * DAY * 1000).toISOString().slice(0, 10)}

## Now

- storefront

## Next

- newsletter

## Later

- cli-tool

## Parked

## Up next

1. storefront :: order confirmation email
2. newsletter :: pick the cover story @you
`);
  return S;
}
