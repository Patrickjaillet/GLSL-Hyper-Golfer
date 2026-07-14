#!/usr/bin/env node
// End-to-end smoke test: serves web/dist (a real production build, not
// the dev server) and drives it with headless Playwright to prove the
// actual user-facing path works — golf a shader, render it in WebGL,
// see the wasm engine active, copy the result — not just that the unit
// tests and parity scripts agree in isolation.
//
// Lives in web/ rather than the top-level scripts/ directory (where
// parity-test.mjs/wasm-check.mjs live) because it needs to resolve the
// `playwright` package, which is only installed in web/node_modules —
// a plain bare-specifier import can't reach across from scripts/.
//
// Clicks go through `element.click()` inside `page.evaluate()` rather
// than Playwright's own `page.click()`: this project's own dev sandbox
// hit a case where the WebGL viewport's continuous requestAnimationFrame
// loop, combined with software GL rendering, starved Playwright's
// actionability/stability checks badly enough that even unrelated
// button clicks hung until timeout (see ROADMAP-UI.md). Driving clicks
// from inside the page sidesteps that CDP-level interaction entirely —
// cheap insurance against the same class of flake recurring in CI's
// runner, which also has no real GPU.
//
// Usage: node e2e-test.mjs   (run from web/, after `npm run build`)

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "dist");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const server = createServer(async (req, res) => {
  const path = (req.url === "/" ? "/index.html" : req.url).split("?")[0];
  try {
    const data = await readFile(join(DIST, path));
    res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const url = `http://localhost:${port}/`;

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "ok" : "FAIL"}: ${label}`);
  if (!cond) failed = true;
}

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" && !msg.text().includes("ERR_FAILED")) consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));
// The build's fonts are loaded from Google Fonts — irrelevant to
// correctness (the font-family fallback stack still renders text) but
// CI runners commonly have no route to it, and Playwright's own
// network-idle/font-wait bookkeeping can stall against an unreachable
// host rather than failing fast.
await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
await page.route("https://fonts.gstatic.com/**", (route) => route.abort());

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#run-btn", { timeout: 15000 });
  await page.waitForTimeout(1200); // wasm init + first default-shader golf run

  const noErrorOnLoad = await page.evaluate(() => !document.getElementById("error-banner").classList.contains("visible"));
  check("default shader compiles with no error banner", noErrorOnLoad);

  const engineLabel = await page.evaluate(() => document.getElementById("engine-label").textContent);
  check("wasm engine is active (not the TS fallback)", engineLabel === "Rust → wasm");

  // Default level is "aggressive" (every pass checkbox starts ticked) —
  // switch to "safe" and back to exercise the level dropdown itself,
  // same click-avoidance rationale as elsewhere in this file.
  await page.evaluate(() => {
    const sel = document.getElementById("golf-level-select");
    sel.value = "safe";
    sel.dispatchEvent(new Event("change"));
  });
  await page.waitForTimeout(500);
  const noErrorSafe = await page.evaluate(() => !document.getElementById("error-banner").classList.contains("visible"));
  check("safe-level golf on the default shader has no error banner", noErrorSafe);

  await page.evaluate(() => {
    const sel = document.getElementById("golf-level-select");
    sel.value = "aggressive";
    sel.dispatchEvent(new Event("change"));
  });
  await page.waitForTimeout(500);
  const noErrorAggressive = await page.evaluate(() => !document.getElementById("error-banner").classList.contains("visible"));
  check("aggressive-level golf on the default shader has no error banner", noErrorAggressive);

  const outputText = await page.evaluate(() => document.querySelector("#output-editor-mount .cm-content")?.textContent ?? "");
  check("golfed output is non-empty", outputText.trim().length > 0);

  // Confirms the viewport is *actually* rendering frames, not just
  // "no compile error" — an FPS of 0 or blank would mean the render
  // loop never started even though compilation succeeded.
  await page.waitForTimeout(700);
  const fps = await page.evaluate(() => document.getElementById("fps-value").textContent);
  check("fps counter shows a positive number (viewport is rendering)", /^\d+$/.test(fps ?? "") && Number(fps) > 0);

  const copyDidNotThrow = await page.evaluate(() => {
    try {
      document.getElementById("copy-btn").click();
      return true;
    } catch {
      return false;
    }
  });
  check("copy button click does not throw", copyDidNotThrow);

  check("no console errors", consoleErrors.length === 0);
  if (consoleErrors.length > 0) {
    console.log(JSON.stringify(consoleErrors, null, 2));
  }
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error("\ne2e-test.mjs: one or more checks failed.");
  process.exit(1);
}
console.log("\ne2e-test.mjs: all checks passed.");
