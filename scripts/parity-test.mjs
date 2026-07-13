#!/usr/bin/env node
// Cross-language regression check: the README claims the TypeScript
// port in web/src/golfer.ts produces output "identical
// character-for-character" to the Rust engine in rust-core/. Nothing
// automated verified that until this script — see ROADMAP.md ("Tests
// de non-régression absents en TS"). It compiles golfer.ts standalone,
// runs both engines over every fixture in fixtures/ in both safe and
// aggressive mode, and fails loudly on any byte-for-byte divergence.
//
// Usage: node scripts/parity-test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES_DIR = join(ROOT, "fixtures");
const GOLFER_TS = join(ROOT, "web", "src", "golfer.ts");
const RUST_BIN_RELEASE = join(ROOT, "rust-core", "target", "release", "golf.exe");
const RUST_BIN_DEBUG = join(ROOT, "rust-core", "target", "debug", "golf.exe");

function findRustBinary() {
  for (const candidate of [RUST_BIN_RELEASE, RUST_BIN_DEBUG]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  console.error("Rust `golf` binary not found — run `cargo build --release` in rust-core/ first.");
  process.exit(1);
}

function runRust(binPath, source, aggressive) {
  const args = aggressive ? ["--aggressive"] : [];
  return execFileSync(binPath, args, { input: source, encoding: "utf8" });
}

async function compileGolferTs() {
  const tmpDir = mkdtempSync(join(tmpdir(), "glslgolf-parity-"));
  const tscJs = join(ROOT, "web", "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tscJs, GOLFER_TS, "--module", "es2020", "--target", "es2020", "--outDir", tmpDir], {
    stdio: "inherit",
  });
  const modPath = join(tmpDir, "golfer.js");
  const mod = await import(pathToFileURL(modPath).href);
  return { golf: mod.golf, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

async function main() {
  const rustBin = findRustBinary();
  const { golf, cleanup } = await compileGolferTs();

  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".glsl"));
  if (fixtureFiles.length === 0) {
    console.error(`No .glsl fixtures found in ${FIXTURES_DIR}`);
    process.exit(1);
  }

  let failures = 0;
  let checks = 0;

  for (const file of fixtureFiles) {
    const source = readFileSync(join(FIXTURES_DIR, file), "utf8");
    for (const aggressive of [false, true]) {
      checks++;
      const label = `${file} (${aggressive ? "aggressive" : "safe"})`;
      const rustOut = runRust(rustBin, source, aggressive).trimEnd();
      const tsOut = golf(source, aggressive).code.trimEnd();
      if (rustOut !== tsOut) {
        failures++;
        console.error(`\nMISMATCH: ${label}`);
        console.error(`  rust: ${JSON.stringify(rustOut)}`);
        console.error(`  ts:   ${JSON.stringify(tsOut)}`);
      } else {
        console.log(`ok: ${label}`);
      }
    }
  }

  cleanup();

  console.log(`\n${checks - failures}/${checks} parity checks passed.`);
  if (failures > 0) {
    process.exit(1);
  }
}

main();
