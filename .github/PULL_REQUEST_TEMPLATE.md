## What changed and why

## Checklist

- [ ] `ROADMAP.md` updated (engine/pass changes) and/or `CHANGELOG.md` updated (user-facing changes)
- [ ] New/changed golfing pass: dedicated test + fixture under `fixtures/*.glsl`
- [ ] `cargo test` and `node scripts/parity-test.mjs` pass (Rust/TypeScript parity)
- [ ] `node scripts/golf-size-budget.mjs` passes (no golfed-size regression)
- [ ] Web changes: `npm run lint`, `npx tsc -b`, `npm run build`, `npm run e2e` pass in `web/`
