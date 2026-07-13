#!/usr/bin/env node
// Verifies the wasm build (web/src/wasm-pkg/) produces byte-for-byte
// identical output to the Rust CLI, the same way parity-test.mjs
// verifies the TS port — except this one should be trivially true by
// construction (same Rust source, different compile target), so a
// mismatch here would mean the wasm-pkg/ copy is stale relative to
// rust-core/src, not a real algorithmic divergence.
//
// Usage: node scripts/wasm-check.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES_DIR = join(ROOT, "fixtures");
const WASM_JS = join(ROOT, "web", "src", "wasm-pkg", "glsl_golf_core.js");
const WASM_BIN = join(ROOT, "web", "src", "wasm-pkg", "glsl_golf_core_bg.wasm");
const RUST_BIN = join(ROOT, "rust-core", "target", "release", "golf.exe");

function runRust(source, aggressive) {
  const args = aggressive ? ["--aggressive"] : [];
  return execFileSync(RUST_BIN, args, { input: source, encoding: "utf8" });
}

async function main() {
  const wasmMod = await import(pathToFileURL(WASM_JS).href);
  await wasmMod.default(readFileSync(WASM_BIN)); // Node's fetch() can't load file:// URLs, so init() with raw bytes instead.

  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".glsl"));
  let failures = 0;
  let checks = 0;

  for (const file of fixtureFiles) {
    const source = readFileSync(join(FIXTURES_DIR, file), "utf8");
    for (const aggressive of [false, true]) {
      checks++;
      const label = `${file} (${aggressive ? "aggressive" : "safe"})`;
      const rustOut = runRust(source, aggressive).trimEnd();
      const wasmOut = wasmMod.golf_code(source, aggressive).trimEnd();
      if (rustOut !== wasmOut) {
        failures++;
        console.error(`\nMISMATCH: ${label}`);
        console.error(`  cli:  ${JSON.stringify(rustOut)}`);
        console.error(`  wasm: ${JSON.stringify(wasmOut)}`);
      } else {
        console.log(`ok: ${label}`);
      }
    }
  }

  console.log(`\n${checks - failures}/${checks} wasm parity checks passed.`);
  if (failures > 0) process.exit(1);
}

main();
