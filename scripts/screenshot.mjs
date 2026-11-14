#!/usr/bin/env node
/**
 * Capture the dashboard for the docs.
 *
 *   node scripts/screenshot.mjs [url] [outfile]
 *
 * Uses a viewport-sized capture, NOT fullPage: a fullPage screenshot resizes
 * the viewport, which re-triggers the dashboard's View Transition and captures
 * the page mid-animation (overlapping panels).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import puppeteer from "puppeteer-core";

const URL = process.argv[2] || "http://localhost:8000/dashboard/";
const OUT = process.argv[3] || "docs/images/dashboard.png";

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
    "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  const cache = join(homedir(), ".cache", "puppeteer", "chrome");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      for (const rel of [join(dir, "chrome-linux64", "chrome"),
        join("chrome-linux64", "chrome"), join(dir, "chrome-linux", "chrome")]) {
        const p = join(cache, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.error("No Chrome found (set CHROME_PATH, or: npx puppeteer browsers install chrome)");
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--force-device-scale-factor=2"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: "networkidle2", timeout: 30_000 });

// let the first poll land and every View Transition finish
await page.waitForFunction(
  () => Number(document.getElementById("kpi-requests")?.dataset.value || 0) > 0,
  { timeout: 20_000 },
).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

await page.screenshot({ path: OUT });
console.log(`wrote ${OUT}`);
await browser.close();