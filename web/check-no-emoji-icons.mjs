#!/usr/bin/env node
// Fails the build if a legacy emoji/glyph icon sneaks back into main.ts —
// ROADMAP.md Phase 2.4/12: every button icon in the NIGHTWIRE UI must be a
// hand-authored SVG (see src/assets/icons/), never an emoji or system icon
// font character. Kept as its own script (not folded into eslint) because
// it's a content check on a specific historical regression, not a general
// lint rule — see git history for the ⇩⇧⚙⏸📷⏺✕ characters this replaces.
//
// Usage: node check-no-emoji-icons.mjs   (run from web/, wired into `npm run build`)

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = join(HERE, "src", "main.ts");

// The exact glyphs this refactor replaced with SVG icons (the size-badge
// ✓/✗ went last, once `icon-badge-fits.svg`/`icon-badge-toobig.svg`
// replaced them too). Deliberately an explicit list, not a broad Unicode
// emoji-block sweep — a blanket range check over-fires on ordinary
// punctuation/symbols that show up in translated strings and code
// comments, which aren't the regression this guards against.
const BANNED = ["⇩", "⇧", "⚙", "⏸", "⏹", "⏺", "📷", "✕", "▶", "✓", "✗"];

const src = await readFile(TARGET, "utf8");
const problems = [];

for (const glyph of BANNED) {
  if (src.includes(glyph)) problems.push(`banned legacy glyph ${JSON.stringify(glyph)} found in main.ts`);
}

if (problems.length > 0) {
  console.error("check-no-emoji-icons: FAILED\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

console.log("check-no-emoji-icons: ok (no emoji/legacy glyph icons in main.ts)");
