//! glsl_golf_core
//!
//! A real, tokenizer-based GLSL "hyper-golfing" engine: it actually
//! parses the shader you give it (comments, preprocessor lines,
//! numeric literals, identifiers, operators) and golfs *that*, instead
//! of returning a fixed canned string regardless of input.
//!
//! Passes applied:
//!   1. comment / whitespace stripping
//!   2. frequency-ranked local/global identifier renaming
//!      (host-facing names like `mainImage`, `iResolution`, `iTime`
//!      and all GLSL keywords/builtins are protected)
//!   3. numeric literal shortening (`0.5` -> `.5`, `2.0` -> `2.`)
//!   4. minimal-whitespace layout (only inserted where two tokens
//!      would otherwise fuse)

mod aggressive;
mod golfer;
mod lexer;
mod vocab;

pub use aggressive::AggressiveStats;
pub use golfer::{golf, golf_with_options, golf_with_protected_names, AggressiveOptions, GolfResult, GolfStats};

#[cfg(feature = "wasm")]
mod wasm_api {
    use super::golfer::{self, AggressiveOptions};
    use wasm_bindgen::prelude::*;

    /// Golfs `source` and returns a JSON string: `{"code": "...", "stats": {...}}`.
    /// `aggressive` is all-or-nothing — see `golf_json_protected` for
    /// per-pass control and/or a protected-names list.
    #[wasm_bindgen]
    pub fn golf_json(source: &str, aggressive: bool) -> String {
        let result = golfer::golf(source, aggressive);
        serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string())
    }

    /// Golfs `source` with individually-toggleable aggressive passes
    /// (backs the UI's per-pass checkboxes) plus a comma-separated list
    /// of identifiers that must never be renamed (custom uniforms a
    /// host application binds by name, typically) — a single string
    /// rather than a JS array to keep the wasm-bindgen surface simple,
    /// matching how a single text input in the UI naturally provides
    /// this. Returns the same JSON shape as `golf_json`.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen]
    pub fn golf_json_protected(
        source: &str,
        eliminate_dead_locals: bool,
        eliminate_dead_stores: bool,
        fold_constants: bool,
        reduce_constant_vectors: bool,
        strip_trailing_void_return: bool,
        compound_assignments: bool,
        increment_decrement: bool,
        ternary_from_if_else: bool,
        merge_declarations: bool,
        strip_redundant_braces: bool,
        strip_redundant_parens: bool,
        protected_names: &str,
    ) -> String {
        let options = AggressiveOptions {
            eliminate_dead_locals,
            eliminate_dead_stores,
            fold_constants,
            reduce_constant_vectors,
            strip_trailing_void_return,
            compound_assignments,
            increment_decrement,
            ternary_from_if_else,
            merge_declarations,
            strip_redundant_braces,
            strip_redundant_parens,
        };
        let names: Vec<String> = protected_names
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let result = golfer::golf_with_protected_names(source, options, &names);
        serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string())
    }

    /// Convenience export returning only the golfed code.
    #[wasm_bindgen]
    pub fn golf_code(source: &str, aggressive: bool) -> String {
        golfer::golf(source, aggressive).code
    }
}
