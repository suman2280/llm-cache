// UI smoke test — the demo moment, driven in a real browser (docs/validation.md G-live).
//
//   npm i -D puppeteer-core          # dev-only, one time
//   node scripts/ui_smoke.mjs [url]  # default http://localhost:8000/dashboard/
//
// Requires the proxy running (uv run uvicorn llm_cache.app:app --port 8000)
// with Redis + Ollama up. Exercises: page renders from live /stats, the
// Run-the-demo button performs miss -> exact-hit -> semantic-hit through
// the real cache, a row expands to the full answer, and no external
// network requests are made (the offline claim).

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const URL = process.argv[2] || "http://localhost:8000/dashboard/";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";

// Deterministic precondition: the first demo step must be a *miss*, so the
// cache starts empty and counters start at zero. (On a warm cache the demo
// reports whatever the cache says — truthful, but not the canonical three.)
try {
  execSync(
    "docker exec llm-cache-redis redis-cli --scan --pattern 'sem:*' | " +
      "xargs -r docker exec -i llm-cache-redis redis-cli UNLINK",
    { stdio: "ignore" },
  );
  await fetch("http://localhost:8000/stats/reset", { method: "POST" });
} catch {
  console.log("note: could not purge cache/reset counters — the canonical sequence may not hold");
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

  // 2. kill the backend -> stale banner, last payload kept (honesty under failure)
  await page.setOfflineMode(true);
  await new Promise((r) => setTimeout(r, 2500));
  const bannerVisible = await page.$eval("#stale-banner", (el) => !el.hidden);
  const chipStale = await page.$eval("#live-chip", (el) => el.textContent.includes("stale"));
  await page.setOfflineMode(false);
  check("stale state on /stats failure", bannerVisible && chipStale);

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

  check("zero external requests (offline claim)", external.length === 0, external.slice(0, 2).join(", "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
