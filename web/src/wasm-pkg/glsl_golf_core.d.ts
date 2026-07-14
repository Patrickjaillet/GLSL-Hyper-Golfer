/* tslint:disable */
/* eslint-disable */

/**
 * Convenience export returning only the golfed code.
 */
export function golf_code(source: string, aggressive: boolean): string;

/**
 * Golfs `source` and returns a JSON string: `{"code": "...", "stats": {...}}`.
 * `aggressive` is all-or-nothing — see `golf_json_protected` for
 * per-pass control and/or a protected-names list.
 */
export function golf_json(source: string, aggressive: boolean): string;

/**
 * Golfs `source` with individually-toggleable aggressive passes
 * (backs the UI's per-pass checkboxes) plus a comma-separated list
 * of identifiers that must never be renamed (custom uniforms a
 * host application binds by name, typically) — a single string
 * rather than a JS array to keep the wasm-bindgen surface simple,
 * matching how a single text input in the UI naturally provides
 * this. Returns the same JSON shape as `golf_json`.
 */
export function golf_json_protected(source: string, eliminate_dead_locals: boolean, eliminate_dead_stores: boolean, fold_constants: boolean, reduce_constant_vectors: boolean, strip_trailing_void_return: boolean, compound_assignments: boolean, increment_decrement: boolean, ternary_from_if_else: boolean, merge_declarations: boolean, strip_redundant_braces: boolean, strip_redundant_parens: boolean, strip_duplicate_precision: boolean, eliminate_dead_functions: boolean, protected_names: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly golf_code: (a: number, b: number, c: number, d: number) => void;
    readonly golf_json: (a: number, b: number, c: number, d: number) => void;
    readonly golf_json_protected: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
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
