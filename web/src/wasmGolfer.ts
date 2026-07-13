/**
 * Thin wrapper around the wasm-bindgen package generated from
 * `rust-core` (`wasm-pack build --target web --release --features
 * wasm`, copied into `./wasm-pkg/`). Exposes the same `(source,
 * aggressive) -> GolfResult` shape as `golfer.ts`'s `golf()` so the two
 * are interchangeable at the call site in `main.ts`.
 *
 * Using the actual Rust engine here — rather than the TypeScript port —
 * eliminates the TS/Rust divergence risk by construction: there is only
 * one implementation of the golfing passes, just two ways to run it.
 * `#[serde(rename_all = "camelCase")]` on `GolfStats`/`AggressiveStats`
 * in `rust-core` makes the JSON this returns match the TS `GolfResult`
 * shape directly, with no manual field-mapping layer to drift out of
 * sync.
 */
import init, { golf_json, golf_json_ex } from "./wasm-pkg/glsl_golf_core.js";
import type { AggressiveOptions, GolfResult } from "./golfer";

let ready: Promise<void> | null = null;

/** Initializes the wasm module. Safe to call more than once — later calls reuse the same promise. */
export function initWasmGolfer(): Promise<void> {
  if (!ready) {
    ready = init().then(() => undefined);
  }
  return ready;
}

/**
 * Synchronous drop-in for golfer.ts's `golf()` — only call after
 * `initWasmGolfer()` has resolved. A plain boolean uses the simpler
 * `golf_json` wasm export; per-pass `AggressiveOptions` uses
 * `golf_json_ex`, which backs the UI's individual checkboxes.
 */
export function wasmGolf(source: string, aggressive: boolean | AggressiveOptions = false): GolfResult {
  const json =
    typeof aggressive === "boolean"
      ? golf_json(source, aggressive)
      : golf_json_ex(
          source,
          aggressive.eliminateDeadLocals,
          aggressive.eliminateDeadStores,
          aggressive.foldConstants,
          aggressive.reduceConstantVectors,
          aggressive.stripTrailingVoidReturn,
          aggressive.compoundAssignments,
          aggressive.incrementDecrement,
          aggressive.mergeDeclarations,
          aggressive.stripRedundantBraces,
        );
  return JSON.parse(json) as GolfResult;
}
