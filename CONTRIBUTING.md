# Contributing

Thanks for your interest in GLSL Hyper-Golfer.

## Scope

- `rust-core/` (the golfing engine) and its TypeScript mirror
  `web/src/golfer.ts` are governed by `ROADMAP.md` — read it first,
  it documents what's already been tried, what's intentionally out of
  scope, and the safety rules every new pass must follow (never break
  a shader that used to compile, no heuristic pass without a measured
  net gain).
- The web app (`web/`) is the UI around the engine — not covered by
  `ROADMAP.md`'s scope note, but held to the same correctness bar.

## Before opening a PR

- **English only**, in code, comments, commit messages, and docs.
- **No comments in source code** — if a comment feels necessary,
  prefer a clearer name or a short doc line at the function/module
  level instead.
- Any change to golfing behavior needs: a dedicated test, a fixture
  under `fixtures/*.glsl` if it's a new pass, and both `cargo test`
  and `node scripts/parity-test.mjs` green (Rust and TypeScript must
  stay in lockstep).
- Run `node scripts/golf-size-budget.mjs` — it fails if the total
  golfed size across the fixture corpus regresses.
- For web changes: `npm run lint`, `npx tsc -b`, `npm run build`, and
  `npm run e2e` in `web/`.
- Update `ROADMAP.md` for engine changes and `CHANGELOG.md` for
  user-facing changes, in the same PR.

## Reporting a bug

Open an issue with the shader source that reproduces it (before and
after golfing, if relevant), the golf level/passes used, and what you
expected vs. what happened.
