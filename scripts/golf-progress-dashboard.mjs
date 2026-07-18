#!/usr/bin/env node
// Progress dashboard (ROADMAP.md Phase 0): concrete proof, in bytes, that
// the golfing engine has gotten more powerful over time -- not just an
// assertion.
//
// Default mode is fast: it reads the committed history of
// scripts/golf-size-baseline.json (updated by golf-size-budget.mjs on
// every commit that touches golfing power) and reports the total for
// two views, because the fixture corpus itself grows over time (new
// passes add new fixtures) and a raw total conflates "golfed better"
// with "tested more":
//   - total bytes: the full corpus at that commit (includes fixture growth)
//   - common bytes: only the fixtures present in EVERY commit in the
//     history (the intersection) -- but even this can grow if an
//     existing fixture's *source* was extended with new lines, which
//     is why --replay (below) is the rigorous version.
//
// --replay is the rigorous version: it builds the Rust CLI as it
// existed at each historical commit (via a throwaway git worktree) and
// runs each historical binary against TODAY's frozen fixtures. That
// isolates the one variable that actually matters -- did the engine
// itself golf the exact same input smaller over time -- with fixture
// content held constant. Slower (one `cargo build --release` per
// commit), so it's opt-in.
//
// Usage:
//   node scripts/golf-progress-dashboard.mjs               # fast, from committed baselines
//   node scripts/golf-progress-dashboard.mjs --replay       # rigorous, rebuilds each historical engine
//   node scripts/golf-progress-dashboard.mjs --out FILE.md  # also write a Markdown report (either mode)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_REL = "scripts/golf-size-baseline.json";
const BIN_NAME = process.platform === "win32" ? "golf.exe" : "golf";

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function loadHistory() {
  const log = git([
    "log",
    "--follow",
    "--reverse",
    "--format=%H\t%ad\t%s",
    "--date=short",
    "--",
    BASELINE_REL,
  ]).trim();

  if (!log) {
    console.error(`No history found for ${BASELINE_REL}`);
    process.exit(1);
  }

  return log.split("\n").map((line) => {
    const [hash, date, ...subjectParts] = line.split("\t");
    return { hash, date, subject: subjectParts.join("\t") };
  });
}

function loadBaselineAt(hash) {
  return JSON.parse(git(["show", `${hash}:${BASELINE_REL}`]));
}

// Fast mode: totals as recorded in the committed baseline at each commit.
function fastRows(commits) {
  const snapshots = commits.map((c) => ({ ...c, baseline: loadBaselineAt(c.hash) }));

  const commonFixtures = snapshots
    .map((s) => new Set(Object.keys(s.baseline.perFixture)))
    .reduce((acc, set) => new Set([...acc].filter((f) => set.has(f))));

  return snapshots.map((s) => {
    const fixtureCount = Object.keys(s.baseline.perFixture).length;
    const commonBytes = [...commonFixtures].reduce((sum, f) => sum + s.baseline.perFixture[f], 0);
    return { hash: s.hash.slice(0, 7), date: s.date, subject: s.subject, fixtureCount, totalBytes: s.baseline.totalBytes, metric: commonBytes };
  });
}

function golfBytes(binPath, source) {
  const out = execFileSync(binPath, ["--aggressive"], { input: source, encoding: "utf8" }).trimEnd();
  return Buffer.byteLength(out, "utf8");
}

// Rigorous mode: build the historical engine at each commit, run it
// against today's frozen fixtures.
function replayRows(commits) {
  const fixturesDir = join(ROOT, "fixtures");
  const todaysFixtures = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".glsl"))
    .sort()
    .map((f) => ({ name: f, source: readFileSync(join(fixturesDir, f), "utf8") }));

  const rows = [];
  for (const c of commits) {
    const worktree = mkdtempSync(join(tmpdir(), "glslgolf-hist-"));
    try {
      git(["worktree", "add", "--detach", worktree, c.hash]);
      execFileSync("cargo", ["build", "--release", "--bin", "golf"], {
        cwd: join(worktree, "rust-core"),
        stdio: "inherit",
      });
      const binPath = join(worktree, "rust-core", "target", "release", BIN_NAME);
      let totalBytes = 0;
      for (const fx of todaysFixtures) totalBytes += golfBytes(binPath, fx.source);
      rows.push({ hash: c.hash.slice(0, 7), date: c.date, subject: c.subject, fixtureCount: todaysFixtures.length, totalBytes, metric: totalBytes });
      console.log(`  ${c.hash.slice(0, 7)} (${c.date}): ${totalBytes} bytes on today's ${todaysFixtures.length} fixtures`);
    } finally {
      git(["worktree", "remove", "--force", worktree]);
    }
  }
  return rows;
}

function render(rows, metricLabel) {
  const header = ["commit", "date", "fixtures", `${metricLabel}`, "delta", "subject"];
  const lines = [header.join(" | "), header.map(() => "---").join(" | ")];
  let prev = null;
  for (const r of rows) {
    const delta = prev === null ? "" : `${r.metric - prev >= 0 ? "+" : ""}${r.metric - prev}`;
    lines.push([r.hash, r.date, r.fixtureCount, r.metric, delta, r.subject].join(" | "));
    prev = r.metric;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const delta = last.metric - first.metric;
  const pct = ((delta / first.metric) * 100).toFixed(1);
  const summary =
    `${metricLabel}: ${first.metric} -> ${last.metric} bytes over ${rows.length} commits ` +
    `(${first.hash}..${last.hash}), ${pct}% ${delta <= 0 ? "reduction" : "growth"}.`;

  return { table: lines.join("\n"), summary };
}

function main() {
  const args = process.argv.slice(2);
  const replay = args.includes("--replay");
  const outIndex = args.indexOf("--out");
  const outPath = outIndex !== -1 ? args[outIndex + 1] : null;

  const commits = loadHistory();

  let rows, metricLabel;
  if (replay) {
    console.log(`Replaying ${commits.length} historical engine builds against today's fixtures (this rebuilds the Rust CLI ${commits.length} times)...\n`);
    rows = replayRows(commits);
    metricLabel = "bytes on today's frozen fixtures";
  } else {
    rows = fastRows(commits);
    metricLabel = `common-subset bytes`;
  }

  const { table, summary } = render(rows, metricLabel);
  console.log("\n" + table);
  console.log("\n" + summary);
  if (!replay) {
    console.log(
      "\n(Fast mode: 'common-subset bytes' can still grow if an existing fixture's own source " +
        "was extended with new lines -- see ROADMAP.md history. Run with --replay for a rigorous " +
        "same-input comparison across historical engine versions.)",
    );
  }

  if (outPath) {
    const md =
      `# Golfing power over time\n\n` +
      `Generated by \`scripts/golf-progress-dashboard.mjs${replay ? " --replay" : ""}\` (see ROADMAP.md Phase 0). ` +
      `Not hand-maintained -- regenerate after any commit that changes golfing power.\n\n` +
      `${summary}\n\n` +
      table +
      "\n";
    writeFileSync(join(ROOT, outPath), md);
    console.log(`\nWritten to ${outPath}`);
  }
}

main();
