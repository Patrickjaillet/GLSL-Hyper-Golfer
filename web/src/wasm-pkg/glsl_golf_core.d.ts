/* tslint:disable */
/* eslint-disable */

/**
 * Convenience export returning only the golfed code.
 */
export function golf_code(source: string, aggressive: boolean): string;

/**
 * Golfs `source` and returns a JSON string: `{"code": "...", "stats": {...}}`.
 * `aggressive` is all-or-nothing — see `golf_json_ex` for per-pass control.
 */
export function golf_json(source: string, aggressive: boolean): string;

/**
 * Golfs `source` with individually-toggleable aggressive passes —
 * backs the UI's per-pass checkboxes. Returns the same JSON shape
 * as `golf_json`.
 */
export function golf_json_ex(source: string, eliminate_dead_locals: boolean, eliminate_dead_stores: boolean, fold_constants: boolean, compound_assignments: boolean, merge_declarations: boolean, strip_redundant_braces: boolean): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly golf_code: (a: number, b: number, c: number) => [number, number];
    readonly golf_json: (a: number, b: number, c: number) => [number, number];
    readonly golf_json_ex: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
