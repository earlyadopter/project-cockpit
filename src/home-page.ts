// The home screen (GET /): ui/home.html with ui/home.css and ui/home.js inlined, so
// the page stays one self-contained response like the detail page. Read once at
// startup — static assets, not live state; restart the dashboard after editing them.
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`./ui/${f}`, import.meta.url), "utf8");

export const HOME_PAGE = read("home.html")
  .replace("/*HOME_CSS*/", () => read("home.css"))
  .replace("/*HOME_JS*/", () => read("home.js"));
