#!/usr/bin/env node
// Golfing-power regression guard (ROADMAP.md Phase 0): golfs every
// fixture at the full "aggressive" level with the Rust engine (the
// canonical implementation — TS/wasm parity is already covered
// separately by parity-test.mjs/wasm-check.mjs) and fails if the total
// output size across the whole corpus grows past a committed baseline.
// The point isn't policing byte-for-byte determinism (fixtures do
// change) — it's making sure that as new golfing passes are added
// (ROADMAP.md Phases 1-4), the engine never gets net *worse* on the
// corpus it's already known to handle well, silently, unnoticed.
//
// Usage:
//   node scripts/golf-size-budget.mjs          # check against the baseline
//   node scripts/golf-size-budget.mjs --update # rewrite the baseline to the current totals
//
// Requires the Rust CLI already built: `cargo build --release --bin golf` in rust-core/.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES_DIR = join(ROOT, "fixtures");
const BASELINE_PATH = join(ROOT, "scripts", "golf-size-baseline.json");
const BIN_NAME = process.platform === "win32" ? "golf.exe" : "golf";
const RUST_BIN_RELEASE = join(ROOT, "rust-core", "target", "release", BIN_NAME);
const RUST_BIN_DEBUG = join(ROOT, "rust-core", "target", "debug", BIN_NAME);

function findRustBinary() {
  for (const candidate of [RUST_BIN_RELEASE, RUST_BIN_DEBUG]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  console.error("Rust `golf` binary not found — run `cargo build --release --bin golf` in rust-core/ first.");
  process.exit(1);
}

function golfBytes(binPath, source) {
  const out = execFileSync(binPath, ["--aggressive"], { input: source, encoding: "utf8" }).trimEnd();
  return Buffer.byteLength(out, "utf8");
}

function main() {
  const update = process.argv.includes("--update");
  const rustBin = findRustBinary();

  const fixtureFiles = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".glsl"))
    .sort();
  if (fixtureFiles.length === 0) {
    console.error(`No .glsl fixtures found in ${FIXTURES_DIR}`);
    process.exit(1);
  }

  const perFixture = {};
  let totalBytes = 0;
  for (const file of fixtureFiles) {
    const source = readFileSync(join(FIXTURES_DIR, file), "utf8");
    const bytes = golfBytes(rustBin, source);
    perFixture[file] = bytes;
    totalBytes += bytes;
  }

  if (update) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ totalBytes, perFixture }, null, 2) + "\n");
    console.log(`Baseline updated: ${totalBytes} total bytes across ${fixtureFiles.length} fixtures (aggressive).`);
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    console.error(`No baseline found at ${BASELINE_PATH} — run with --update to create one.`);
    process.exit(1);
  }

  console.log(`Current: ${totalBytes} bytes  |  Baseline: ${baseline.totalBytes} bytes`);

  const regressed = [];
  for (const file of fixtureFiles) {
    const before = baseline.perFixture[file];
    const after = perFixture[file];
    if (before !== undefined && after > before) {
      regressed.push(`  ${file}: ${before} -> ${after} bytes (+${after - before})`);
    }
  }

  if (totalBytes > baseline.totalBytes) {
    console.error(`\nFAIL: total golfed size regressed by ${totalBytes - baseline.totalBytes} bytes.`);
    if (regressed.length > 0) {
      console.error("Regressed fixtures:");
      console.error(regressed.join("\n"));
    }
    console.error("\nIf this regression is expected (e.g. a fixture's source itself changed), run:");
    console.error("  node scripts/golf-size-budget.mjs --update");
    process.exit(1);
  }

  if (totalBytes < baseline.totalBytes) {
    console.log(
      `\nImproved by ${baseline.totalBytes - totalBytes} bytes vs. the committed baseline — ` +
        "run with --update to lock in the new total (not automatic, so an improvement is a deliberate commit, not a silent drift).",
    );
  } else {
    console.log("\nNo change vs. baseline.");
  }
}

main();
