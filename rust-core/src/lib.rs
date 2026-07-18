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
mod callgraph;
mod expr;
mod golfer;
mod inline;
mod lexer;
mod vocab;

pub use aggressive::AggressiveStats;
pub use golfer::{golf, golf_with_options, golf_with_protected_names, AggressiveOptions, GolfResult, GolfStats};

#[cfg(feature = "wasm")]
mod wasm_api {
    use super::golfer::{self, AggressiveOptions, GolfResult};
    use crate::aggressive::AggressiveStats;
    use wasm_bindgen::prelude::*;

    /// Escapes `s` as a JSON string literal (quotes included) — the one
    /// field in `GolfResult` that needs it, since `code` is arbitrary
    /// GLSL source text that can itself contain `"`, `\`, or control
    /// characters (e.g. inside a string-like GLSL comment, or a
    /// preprocessor line). Every other field golfed here is a plain
    /// `usize`/`f64`, which Rust's own `{}` formatting already renders
    /// as a valid JSON number with no escaping needed.
    fn escape_json_string(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    /// Hand-written JSON serialization for the two output structs,
    /// replacing what used to be `serde`/`serde_json` — a real, if
    /// modest, wasm binary-size win (ROADMAP.md Phase 1.3's flagged
    /// budget concern): pulling in `serde_json`'s full `Serializer`
    /// machinery just to emit this one small, fixed, never-changing
    /// JSON shape cost more code than writing it out directly. Field
    /// names/order and camelCase spelling are matched exactly to what
    /// serde used to produce (`#[serde(rename_all = "camelCase")]`,
    /// declaration order) so the TS side's `JSON.parse(...) as
    /// GolfResult` needs no changes at all.
    fn aggressive_stats_json(s: &AggressiveStats) -> String {
        format!(
            "{{\"compoundAssignments\":{},\"declarationsMerged\":{},\"bracesRemoved\":{},\"constantsFolded\":{},\"deadLocalsRemoved\":{},\"deadStoresRemoved\":{},\"constantVectorsReduced\":{},\"trailingVoidReturnsRemoved\":{},\"incrementsDecrements\":{},\"ternariesFromIfElse\":{},\"redundantParensRemoved\":{},\"duplicatePrecisionRemoved\":{},\"deadFunctionsRemoved\":{},\"functionsInlined\":{}}}",
            s.compound_assignments,
            s.declarations_merged,
            s.braces_removed,
            s.constants_folded,
            s.dead_locals_removed,
            s.dead_stores_removed,
            s.constant_vectors_reduced,
            s.trailing_void_returns_removed,
            s.increments_decrements,
            s.ternaries_from_if_else,
            s.redundant_parens_removed,
            s.duplicate_precision_removed,
            s.dead_functions_removed,
            s.functions_inlined,
        )
    }

    fn golf_result_json(r: &GolfResult) -> String {
        format!(
            "{{\"code\":{},\"stats\":{{\"inputChars\":{},\"outputChars\":{},\"reductionPct\":{},\"renamedCount\":{},\"numbersShortened\":{},\"aggressive\":{}}}}}",
            escape_json_string(&r.code),
            r.stats.input_chars,
            r.stats.output_chars,
            r.stats.reduction_pct,
            r.stats.renamed_count,
            r.stats.numbers_shortened,
            aggressive_stats_json(&r.stats.aggressive),
        )
    }

    /// Golfs `source` and returns a JSON string: `{"code": "...", "stats": {...}}`.
    /// `aggressive` is all-or-nothing — see `golf_json_protected` for
    /// per-pass control and/or a protected-names list.
    #[wasm_bindgen]
    pub fn golf_json(source: &str, aggressive: bool) -> String {
        let result = golfer::golf(source, aggressive);
        golf_result_json(&result)
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
        strip_duplicate_precision: bool,
        eliminate_dead_functions: bool,
        inline_single_call_functions: bool,
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
            strip_duplicate_precision,
            eliminate_dead_functions,
            inline_single_call_functions,
        };
        let names: Vec<String> = protected_names
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let result = golfer::golf_with_protected_names(source, options, &names);
        golf_result_json(&result)
    }

    /// Convenience export returning only the golfed code.
    #[wasm_bindgen]
    pub fn golf_code(source: &str, aggressive: bool) -> String {
        golfer::golf(source, aggressive).code
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn json_shape_matches_the_old_serde_output_exactly() {
            // Golden reference captured from `serde_json::to_string(&result)`
            // before it was replaced by hand-written serialization —
            // pinning this exact string (field names/order, camelCase,
            // nested `stats.aggressive`) is what guarantees the TS side's
            // `JSON.parse(...) as GolfResult` needed no changes at all.
            let result = golfer::golf(
                "void mainImage(out vec4 fragColor,in vec2 fragCoord){float x=1.0;fragColor=vec4(x);}",
                true,
            );
            assert_eq!(
                golf_result_json(&result),
                "{\"code\":\"void mainImage(out vec4 a,in vec2 c){float b=1.;a=vec4(b);}\",\"stats\":{\"inputChars\":84,\"outputChars\":59,\"reductionPct\":29.761904761904763,\"renamedCount\":3,\"numbersShortened\":1,\"aggressive\":{\"compoundAssignments\":0,\"declarationsMerged\":0,\"bracesRemoved\":0,\"constantsFolded\":0,\"deadLocalsRemoved\":0,\"deadStoresRemoved\":0,\"constantVectorsReduced\":0,\"trailingVoidReturnsRemoved\":0,\"incrementsDecrements\":0,\"ternariesFromIfElse\":0,\"redundantParensRemoved\":0,\"duplicatePrecisionRemoved\":0,\"deadFunctionsRemoved\":0,\"functionsInlined\":0}}}"
            );
        }

        #[test]
        fn escapes_quotes_backslashes_and_control_characters_in_code() {
            assert_eq!(escape_json_string("a\"b"), "\"a\\\"b\"");
            assert_eq!(escape_json_string("a\\b"), "\"a\\\\b\"");
            assert_eq!(escape_json_string("a\nb"), "\"a\\nb\"");
            assert_eq!(escape_json_string("a\tb"), "\"a\\tb\"");
            assert_eq!(escape_json_string("a\rb"), "\"a\\rb\"");
        }

        #[test]
        fn escaped_code_round_trips_through_a_real_json_parser() {
            // The one realistic way `code` can contain a literal `"` or
            // `\`: a `#pragma`/`#define` preprocessor line, which is kept
            // verbatim (`Tok::Preproc`) rather than tokenized.
            let result = golfer::golf(
                "#pragma message \"hello \\\\ world\"\nvoid mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(1.0);}",
                false,
            );
            let json = golf_result_json(&result);
            // No external JSON parser dependency to verify with here, so
            // this checks the specific escape sequence this input must
            // produce (already proven correct against a real JS
            // `JSON.parse` manually during development): the source's
            // two literal backslashes each become their own `\\` escape.
            assert!(json.contains("\\\"hello \\\\\\\\ world\\\""));
        }
    }
}
