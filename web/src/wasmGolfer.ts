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
import init, { golf_json, golf_json_protected } from "./wasm-pkg/glsl_golf_core.js";
import { allAggressiveOptions, type AggressiveOptions, type GolfResult } from "./golfer";

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
 * `initWasmGolfer()` has resolved. The common case (plain boolean, no
 * protected names) uses the simpler `golf_json` wasm export; per-pass
 * `AggressiveOptions` and/or a non-empty `protectedNames` use
 * `golf_json_protected`, which backs both the UI's individual
 * checkboxes and the protected-names field.
 */
export function wasmGolf(
  source: string,
  aggressive: boolean | AggressiveOptions = false,
  protectedNames: string[] = [],
): GolfResult {
  if (typeof aggressive === "boolean" && protectedNames.length === 0) {
    return JSON.parse(golf_json(source, aggressive)) as GolfResult;
  }
  const options: AggressiveOptions = typeof aggressive === "boolean" ? allAggressiveOptions(aggressive) : aggressive;
  const json = golf_json_protected(
    source,
    options.eliminateDeadLocals,
    options.eliminateDeadStores,
    options.foldConstants,
    options.reduceConstantVectors,
    options.stripTrailingVoidReturn,
    options.compoundAssignments,
    options.incrementDecrement,
    options.ternaryFromIfElse,
    options.mergeDeclarations,
    options.stripRedundantBraces,
    options.stripRedundantParens,
    options.stripDuplicatePrecision,
    protectedNames.join(","),
  );
  return JSON.parse(json) as GolfResult;
}
