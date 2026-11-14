// UI smoke test — the demo moment, driven in a real browser.
//
//   npm i -D puppeteer-core          # dev-only, one time
//   node scripts/ui_smoke.mjs [url]  # default http://localhost:8000/dashboard/
//
// Requires the app running (node src/main.js) with Redis up. Exercises: page
// renders from live /stats, the Run-the-demo button performs
// miss -> exact-hit -> semantic-hit through the real cache, a row expands to
// the full answer, and no external network requests are made (the offline
// claim).
//
// Chrome: set CHROME_PATH, or let it find the puppeteer-managed build.

import { readFileSync, readdirSync, existsSync } from "node:fs";

import { join } from "node:path";
import { homedir } from "node:os";
import puppeteer from "puppeteer-core";

const URL = process.argv[2] || "http://localhost:8000/dashboard/";

/** Locate a Chrome: explicit env, a system install, or the puppeteer cache. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const system = [
    "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  for (const p of system) if (existsSync(p)) return p;
  const cache = join(homedir(), ".cache", "puppeteer", "chrome");
  if (existsSync(cache)) {
    // the layout is either <cache>/<version>/chrome-linux64/chrome (puppeteer's
    // own) or <cache>/chrome-linux64/chrome (a manual unzip of the same zip)
    for (const dir of readdirSync(cache)) {
      for (const rel of [
        join(dir, "chrome-linux64", "chrome"),
        join("chrome-linux64", "chrome"),
        join(dir, "chrome-linux", "chrome"),
      ]) {
        const p = join(cache, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}
const CHROME = findChrome();
if (!CHROME) {
  console.error("No Chrome found. Install one, or: npx puppeteer browsers install chrome");
  console.error("Then re-run, optionally with CHROME_PATH=/path/to/chrome");
  process.exit(2);
}

// Deterministic precondition: the first demo step must be a *miss*, so the
// cache starts empty and counters start to zero. (On a warm cache the demo
// reports whatever the cache says - truthful, but not the canonical three.)
//
// BOTH stores must be cleared: the documents live in SQLite and the vectors in
// Redis. Clearing only the vectors leaves a cache that exact-hits but cannot
// semantically hit.
const ADMIN = process.env.ADMIN_TOKEN || "dev-token";
try {
  const purge = await fetch("http://localhost:8000/cache/purge", {
    method: "POST",
    headers: { "X-Admin-Token": ADMIN, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!purge.ok) throw new Error(`purge returned ${purge.status}`);
  await fetch("http://localhost:8000/stats/reset", { method: "POST" });
} catch (err) {
  console.log(`note: could not purge the cache / reset counters (${err.message}) - ` +
    "the canonical sequence may not hold");
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const page = await browser.newPage();

  // the offline claim: nothing may leave the origin
  const external = [];
  page.on("pageerror", (err) => console.log("PAGEERROR:", err.message));
  page.on("request", (req) => {
    if (!req.url().startsWith("http://localhost") && !req.url().startsWith("data:")) {
      external.push(req.url());
    }
  });

  await page.goto(URL, { waitUntil: "networkidle2", timeout: 30_000 });

  // 1. live render: config strip learned the model from /stats
  await page.waitForFunction(
    () => document.getElementById("hero-model")?.textContent?.trim().length > 1,
    { timeout: 15_000 },
  );
  const model = await page.$eval("#hero-model", (el) => el.textContent);
  check("page renders live /stats (model in hero)", model && model !== "—", model);

  // 2. the backend stops answering -> stale banner, last payload kept
  //    (honesty under failure).
  //
  //    NOTE: Chrome's setOfflineMode() does NOT block requests to localhost --
  //    an in-page fetch still returned 200 while "offline". So the failure is
  //    injected at the network layer instead: /stats is aborted, which is what
  //    the dashboard's catch branch actually has to survive.
  await page.setRequestInterception(true);
  const blocker = (req) => {
    if (req.url().includes("/stats")) req.abort("failed").catch(() => {});
    else req.continue().catch(() => {});
  };
  page.on("request", blocker);
  await page.waitForFunction(
    () => !document.getElementById("stale-banner")?.hidden,
    { timeout: 15_000 },
  );
  const bannerVisible = await page.$eval("#stale-banner", (el) => !el.hidden);
  const chipStale = await page.$eval("#live-chip", (el) => el.textContent.includes("stale"));
  const keptPayload = await page.$eval("#kpi-requests", (el) => el.textContent);
  check("stale state on /stats failure", bannerVisible && chipStale,
    `chip=${await page.$eval("#live-chip", (el) => el.textContent)}`);
  check("last payload kept while stale", keptPayload !== "—", `kpi-requests=${keptPayload}`);

  // restore normal service
  page.off("request", blocker);
  await page.setRequestInterception(false);
  await new Promise((r) => setTimeout(r, 1500));
  const chipLive = await page.$eval("#live-chip", (el) => el.textContent.includes("live"));
  check("recovers to live when /stats returns", chipLive);

  // 3. the demo: three real requests through the real cache
  const before = await page.$$eval("#log .row", (rows) => rows.length);
  await page.click("#demo-btn");
  await page.waitForFunction(
    (n) => document.querySelectorAll("#log .row").length >= n + 3,
    { timeout: 180_000 },
    before,
  );
  const verdicts = await page.$$eval("#log .row .badge", (els) =>
    els.slice(0, 3).map((e) => e.textContent).reverse(), // log is newest-first
  );
  check(
    "demo: miss -> exact-hit -> semantic-hit",
    verdicts.join(",") === "miss,exact-hit,semantic-hit",
    verdicts.join(" -> "),
  );

  // 4. a semantic-hit row names the prompt it was served from
  const servedFrom = await page.$$eval("#log .row", (rows) => {
    const sem = rows.find((r) => r.className.includes("row-semantic-hit"));
    return sem?.querySelector(".row-detail .qa-src")?.textContent ?? "";
  });
  check("semantic-hit names its source prompt", servedFrom.includes("served from:"), servedFrom);

  // 5. row expansion shows the full answer (keyboard-native <details>)
  const firstRow = await page.$("#log .row");
  await firstRow.$eval("summary", (s) => s.click());
  const answerText = await page.$eval("#log .row .row-detail .qa-text", (el) => el.textContent);
  check("expanded row shows the full answer", answerText.length > 20, `${answerText.slice(0, 48)}…`);

  // 6. KPI counters moved without a manual refresh
  const requests = await page.$eval("#kpi-requests", (el) => Number(el.dataset.value));
  check("KPI counters updated", requests > before, `requests=${requests}`);

  // shots for the record: the money moment (expanded row) and the dialog
  await page.screenshot({ path: "/tmp/llm-cache-dashboard.png", fullPage: true });

  // 7. reset confirmation: styled native <dialog>; Esc cancels
  await page.$eval("#reset-btn", (b) => b.click()); // DOM click: a scrolled page can park the button under the sticky header
  await page.waitForSelector("#confirm-dialog[open]", { timeout: 5000 });
  await page.screenshot({ path: "/tmp/llm-cache-dialog.png" });
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  const kept = await page.$eval("#kpi-requests", (el) => Number(el.dataset.value));
  check("Esc cancels the reset dialog", kept === 3, `requests=${kept}`);

  // 8. confirm path zeroes the counters and the log
  await page.$eval("#reset-btn", (b) => b.click()); // DOM click: a scrolled page can park the button under the sticky header
  await page.waitForSelector("#confirm-dialog[open]", { timeout: 5000 });
  await page.click("#confirm-ok");
  await page.waitForFunction(
    () => Number(document.getElementById("kpi-requests").dataset.value) === 0,
    { timeout: 10_000 },
  );
  const rowsLeft = await page.$$eval("#log .row", (r) => r.length);
  check("confirm dialog zeroes counters + log", rowsLeft === 0, `rows=${rowsLeft}`);

  check("zero external requests (offline claim)", external.length === 0, external.slice(0, 2).join(", "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
