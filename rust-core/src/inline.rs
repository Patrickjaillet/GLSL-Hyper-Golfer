//! Single-call-site function inlining (ROADMAP.md Phase 3.2) — the
//! first real consumer of both Phase 2 foundations: `callgraph`
//! answers "is this function called exactly once", `expr` parses the
//! call's argument list and the function's own return expression with
//! real spans, so substitution never has to guess at token boundaries.
//!
//! Scoped narrowly on purpose, the same way every pass in this engine
//! is:
//! - Only a function whose **entire body is a single `return <expr>;`**
//!   is a candidate. No temporaries are ever introduced into the
//!   caller (nothing is declared, only spliced), so there is no
//!   variable-capture/hygiene problem to solve — the parameter name
//!   never survives into the output at all, it's replaced by the
//!   argument's own tokens everywhere it appeared.
//! - Only when **every argument at the call site is a bare operand**
//!   (an identifier or number literal, optionally unary-prefixed — the
//!   same shape `parse_simple_write` already trusts elsewhere in this
//!   engine) does substitution happen. This sidesteps evaluation-order
//!   and multiple-evaluation-of-side-effects concerns entirely, rather
//!   than trying to reason about them: a bare operand has no side
//!   effect and no observable order dependency, so it can be spliced
//!   in as many times (including zero) as the parameter is used in the
//!   return expression, and always safely.
//! - `out`/`inout` parameters, and any parameter with an array
//!   declarator, decline the whole candidate — value-substitution
//!   isn't the right model for either, and this pass doesn't attempt
//!   the lvalue-aliasing reasoning that would be needed to prove it
//!   safe.
//! - Self-recursive candidates (the function's one and only call site
//!   is inside its own body) are declined outright — inlining a
//!   function into itself isn't meaningful.
//! - Overloaded names (more than one definition sharing the name) are
//!   declined, same reasoning as `eliminate_dead_functions`: no type
//!   information here to know which overload a given call resolves to.
//!
//! **Measured, not assumed, net gain** (ROADMAP.md Phase 3's own
//! stated rule): the declaration's full byte cost plus the call site's
//! is compared against the substituted expression's cost (plus two
//! bytes if it needs wrapping in parens — see below) — inlining only
//! happens when that's strictly smaller.
//!
//! **Precedence safety**: the call site was always a primary/postfix-
//! level term in whatever expression it sat inside (postfix binds
//! tighter than anything else in the grammar). Substituting a `Unary`,
//! `Binary`, or `Ternary` return expression in its place *unwrapped*
//! could silently change how the surrounding expression groups (e.g.
//! `2*sq(x)` where `sq` returns `a+1.` would become `2*a+1.`, parsed as
//! `(2*a)+1.` — not `2*(a+1.)`). Rather than prove case-by-case when
//! parens can be safely omitted, every one of those three kinds is
//! always wrapped in `(...)`; only `Number`/`Ident`/`Call`/`Index`/
//! `Member`/`Paren` (all already primary/postfix-level) are spliced in
//! bare.

use crate::aggressive::{skip_balanced, AggressiveStats, Item};
use crate::callgraph::{find_function_definitions, CallGraph, FunctionDef};
use crate::expr::{parse_arg_list, parse_expr, Expr, ExprKind};
use crate::lexer::Tok;
use crate::vocab::{keywords, type_keywords};
use std::collections::HashMap;

fn char_len(items: &[Item]) -> usize {
    items.iter().map(|it| it.text.chars().count()).sum()
}

/// True for the argument shapes this pass will substitute: a bare
/// identifier/number literal, optionally with a single unary prefix —
/// the same restriction `parse_simple_write` already places on a
/// write's right-hand side elsewhere in this engine, for the same
/// reason (no side effect, no evaluation-order question).
fn is_safe_arg(items: &[Item], e: &Expr) -> bool {
    match &e.kind {
        ExprKind::Number(_) | ExprKind::Ident(_) => true,
        ExprKind::Unary(_, inner) => matches!(inner.kind, ExprKind::Number(_) | ExprKind::Ident(_)),
        _ => {
            let _ = items;
            false
        }
    }
}

/// Whether `e` is already at primary/postfix precedence — safe to
/// splice in without parentheses wherever a call expression (itself
/// always primary/postfix) used to be.
fn is_primary_level(e: &Expr) -> bool {
    matches!(
        e.kind,
        ExprKind::Number(_) | ExprKind::Ident(_) | ExprKind::Call(_, _) | ExprKind::Index(_, _) | ExprKind::Member(_, _) | ExprKind::Paren(_)
    )
}

struct Param {
    name: String,
    /// `out`/`inout` qualifier, or an array declarator — either way,
    /// this candidate is declined entirely if any parameter sets this.
    disallowed: bool,
}

/// Parses `(<params>)` starting at the open paren, requiring the whole
/// span to be either empty or a comma-separated list of
/// `[qualifiers] <type> <name> [array]`. Returns `None` for anything
/// that doesn't match this shape (a real GLSL parameter list always
/// does; this is declining to guess at anything stranger, like a
/// `#define`-obscured signature).
fn parse_params(items: &[Item], open_paren: usize) -> Option<(Vec<Param>, usize)> {
    let close_paren = skip_balanced(items, open_paren, '(', ')')? - 1;
    let kw = keywords();
    let type_kw = type_keywords();
    let mut params = Vec::new();
    let mut i = open_paren + 1;
    if i == close_paren {
        return Some((params, close_paren));
    }
    loop {
        let mut disallowed = false;
        while let Some(Tok::Ident(w)) = items.get(i).map(|it| &it.tok) {
            if !kw.contains(w.as_str()) || type_kw.contains(w.as_str()) {
                break;
            }
            if w == "out" || w == "inout" {
                disallowed = true;
            }
            i += 1;
        }
        match items.get(i).map(|it| &it.tok) {
            Some(Tok::Ident(w)) if type_kw.contains(w.as_str()) => i += 1,
            _ => return None,
        }
        let name = match items.get(i).map(|it| &it.tok) {
            Some(Tok::Ident(n)) => n.clone(),
            _ => return None,
        };
        i += 1;
        if matches!(items.get(i).map(|it| &it.tok), Some(Tok::Punct('['))) {
            disallowed = true;
            i = skip_balanced(items, i, '[', ']')?;
        }
        params.push(Param { name, disallowed });
        match items.get(i).map(|it| &it.tok) {
            Some(Tok::Punct(',')) => i += 1,
            Some(Tok::Punct(')')) if i == close_paren => break,
            _ => return None,
        }
    }
    Some((params, close_paren))
}

/// The function body must be exactly `{return <expr>;}` — nothing
/// before it, nothing after. Anything else (multiple statements, a
/// bare `return;`, a non-return statement) declines: no control flow
/// or sequencing to reason about here at all, on purpose.
fn parse_single_return_body(items: &[Item], open_brace: usize, body_close: usize) -> Option<Expr> {
    if items.get(open_brace + 1).map(|it| it.text.as_str()) != Some("return") {
        return None;
    }
    let expr = parse_expr(items, open_brace + 2)?;
    if !matches!(items.get(expr.end).map(|it| &it.tok), Some(Tok::Punct(';'))) {
        return None;
    }
    if expr.end + 1 != body_close {
        return None;
    }
    Some(expr)
}

struct CallSite {
    /// Index of the function-name identifier token.
    name_start: usize,
    /// Index just past the call's closing `)`.
    end: usize,
    args: Vec<Expr>,
}

/// Finds every occurrence of `name(` in `items`, excluding the
/// definition's own signature (`def.def_start + 1`, the same index
/// `callgraph::CallGraph::build` already excludes for the identical
/// reason) and anywhere inside `def`'s own body (a self-recursive call
/// is never a valid inlining site). A real GLSL function name is never
/// referenced without immediately calling it, so every remaining match
/// is necessarily a genuine call site.
fn find_call_sites(items: &[Item], def: &FunctionDef) -> Option<Vec<CallSite>> {
    let mut sites = Vec::new();
    let mut i = 0;
    while i < items.len() {
        let is_own_signature = i == def.def_start + 1;
        let is_within_own_body = i >= def.def_start && i <= def.body_close;
        let matches_name = matches!(items.get(i).map(|it| &it.tok), Some(Tok::Ident(n)) if n == &def.name);
        if matches_name && !is_own_signature && !is_within_own_body && matches!(items.get(i + 1).map(|it| &it.tok), Some(Tok::Punct('('))) {
            let close = skip_balanced(items, i + 1, '(', ')')?;
            let args = parse_arg_list(items, i + 2, close - 1)?;
            sites.push(CallSite { name_start: i, end: close, args });
        }
        i += 1;
    }
    Some(sites)
}

/// Splices `args[k]`'s own tokens in place of every occurrence of
/// `params[k].name` inside `items[expr_start..expr_end]`. `space_before`
/// is forced to `true` on each spliced argument's first token — the
/// same fix `strip_redundant_parens` already established: this only
/// makes the layout engine's own ambiguous-pair check run at the new
/// adjacency, never inserts a space where none is actually needed.
fn substitute_params(items: &[Item], expr_start: usize, expr_end: usize, params: &[Param], args: &[Expr]) -> Vec<Item> {
    let mut out = Vec::new();
    let mut i = expr_start;
    while i < expr_end {
        if let Tok::Ident(name) = &items[i].tok {
            if let Some(pos) = params.iter().position(|p| &p.name == name) {
                let mut arg_tokens: Vec<Item> = items[args[pos].start..args[pos].end].to_vec();
                if let Some(first) = arg_tokens.first_mut() {
                    first.space_before = true;
                }
                out.extend(arg_tokens);
                i += 1;
                continue;
            }
        }
        out.push(items[i].clone());
        i += 1;
    }
    out
}

struct Edit {
    start: usize,
    end: usize,
    replacement: Vec<Item>,
}

fn overlaps(a: (usize, usize), b: (usize, usize)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

/// Inlines every function whose entire body is `return <expr>;`, is
/// called from exactly one, non-recursive call site with only
/// bare-operand arguments, and whose substitution measurably shrinks
/// the total byte count — see the module docs above for the full
/// safety argument.
pub fn inline_single_call_functions(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let defs = find_function_definitions(&items);
    if defs.is_empty() {
        return items;
    }

    let mut name_counts: HashMap<&str, usize> = HashMap::new();
    for d in &defs {
        *name_counts.entry(d.name.as_str()).or_insert(0) += 1;
    }
    let names = defs.iter().map(|d| d.name.clone()).collect();
    let graph = CallGraph::build(&items, &defs, &names);

    let mut edits: Vec<Edit> = Vec::new();

    for def in &defs {
        if def.name == "main" || def.name == "mainImage" {
            continue;
        }
        if name_counts.get(def.name.as_str()).copied().unwrap_or(0) != 1 {
            continue;
        }
        if graph.total_calls_to(&def.name) != 1 {
            continue;
        }
        let Some(sites) = find_call_sites(&items, def) else {
            continue;
        };
        // Exactly one *external* call site is required; if none turned
        // up outside the function's own body, the one call `total_calls_to`
        // counted was self-recursive — decline (see module docs).
        let [site] = sites.as_slice() else {
            continue;
        };

        let open_paren = def.def_start + 2;
        let Some((params, close_paren)) = parse_params(&items, open_paren) else {
            continue;
        };
        if params.iter().any(|p| p.disallowed) {
            continue;
        }
        if params.len() != site.args.len() {
            continue;
        }
        if !site.args.iter().all(|a| is_safe_arg(&items, a)) {
            continue;
        }
        let open_brace = close_paren + 1;
        if !matches!(items.get(open_brace).map(|it| &it.tok), Some(Tok::Punct('{'))) {
            continue;
        }
        let Some(return_expr) = parse_single_return_body(&items, open_brace, def.body_close) else {
            continue;
        };

        let declaration_cost = char_len(&items[def.def_start..=def.body_close]);
        let call_site_cost = char_len(&items[site.name_start..site.end]);
        let before_cost = declaration_cost + call_site_cost;

        let mut substituted = substitute_params(&items, open_brace + 2, return_expr.end, &params, &site.args);
        let needs_wrap = !is_primary_level(&return_expr);
        let after_cost = char_len(&substituted) + if needs_wrap { 2 } else { 0 };

        if after_cost >= before_cost {
            continue;
        }

        let decl_range = (def.def_start, def.body_close + 1);
        let call_range = (site.name_start, site.end);
        if edits.iter().any(|e| overlaps((e.start, e.end), decl_range) || overlaps((e.start, e.end), call_range)) {
            continue;
        }

        if let Some(first) = substituted.first_mut() {
            first.space_before = true;
        }
        let mut replacement = Vec::with_capacity(substituted.len() + 2);
        if needs_wrap {
            replacement.push(Item { tok: Tok::Punct('('), text: "(".to_string(), space_before: true });
            replacement.append(&mut substituted);
            replacement.push(Item { tok: Tok::Punct(')'), text: ")".to_string(), space_before: false });
        } else {
            replacement = substituted;
        }

        stats.functions_inlined += 1;
        edits.push(Edit { start: decl_range.0, end: decl_range.1, replacement: Vec::new() });
        edits.push(Edit { start: call_range.0, end: call_range.1, replacement });
    }

    if edits.is_empty() {
        return items;
    }
    edits.sort_by_key(|e| e.start);

    let mut out = Vec::with_capacity(items.len());
    let mut i = 0;
    let mut edit_iter = edits.into_iter().peekable();
    while i < items.len() {
        if let Some(edit) = edit_iter.peek() {
            if edit.start == i {
                let edit = edit_iter.next().unwrap();
                out.extend(edit.replacement);
                i = edit.end;
                continue;
            }
        }
        out.push(items[i].clone());
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use crate::golfer::golf;

    // Renaming is part of the always-on safe pipeline, so a literal
    // function/parameter name never survives into the golfed output —
    // "return" does, though, if and only if some function definition
    // (this pass's only possible source of one) is still standing.
    // These tests run through the full aggressive pipeline (`golf`,
    // not an isolated single-pass helper) and pin the exact expected
    // string, verified against the real CLI while writing them, so a
    // cascade with another pass (constant folding, dead-code, ...) is
    // caught rather than masked by a looser assertion.

    #[test]
    fn inlines_a_single_call_site_pure_function() {
        let r = golf("float sq(float a){return a*a;}void mainImage(out vec4 c,in vec2 p){float x=p.x;c=vec4(sq(x));}", true);
        assert_eq!(r.code, "void mainImage(out vec4 c,in vec2 d){float a=d.x;c=vec4((a*a));}");
        assert_eq!(r.stats.aggressive.functions_inlined, 1);
    }

    #[test]
    fn wraps_a_substituted_binary_expression_in_parens_when_needed() {
        // sq2 returns a+1., a Binary — spliced where 2*sq2(x) used to
        // call it, it must come out as 2*(x+1.), never 2*x+1.
        let r = golf(
            "float sq2(float a){return a+1.;}void mainImage(out vec4 c,in vec2 p){float x=p.x;c=vec4(2.*sq2(x));}",
            true,
        );
        assert_eq!(r.code, "void mainImage(out vec4 c,in vec2 d){float a=d.x;c=vec4(2.*(a+1.));}");
    }

    #[test]
    fn declines_when_called_more_than_once() {
        let r = golf(
            "float sq(float a){return a*a;}void mainImage(out vec4 c,in vec2 p){c=vec4(sq(p.x)+sq(p.y));}",
            true,
        );
        assert!(r.code.contains("return"), "expected sq to survive being called twice, got: {}", r.code);
        assert_eq!(r.stats.aggressive.functions_inlined, 0);
    }

    #[test]
    fn declines_when_an_argument_is_not_a_bare_operand() {
        let r = golf("float sq(float a){return a*a;}void mainImage(out vec4 c,in vec2 p){c=vec4(sq(p.x+1.));}", true);
        assert!(r.code.contains("return"), "a non-bare-operand argument must decline inlining, got: {}", r.code);
        assert_eq!(r.stats.aggressive.functions_inlined, 0);
    }

    #[test]
    fn declines_an_inout_parameter() {
        let r = golf(
            "float sq(inout float a){return a*a;}void mainImage(out vec4 c,in vec2 p){float x=p.x;c=vec4(sq(x));}",
            true,
        );
        assert!(r.code.contains("return"), "inout parameter must decline inlining, got: {}", r.code);
        assert_eq!(r.stats.aggressive.functions_inlined, 0);
    }

    #[test]
    fn declines_a_multi_statement_body() {
        let r = golf(
            "float sq(float a){float b=a*a;return b;}void mainImage(out vec4 c,in vec2 p){float x=p.x;c=vec4(sq(x));}",
            true,
        );
        assert!(r.code.contains("return"), "multi-statement body must decline inlining, got: {}", r.code);
        assert_eq!(r.stats.aggressive.functions_inlined, 0);
    }

    #[test]
    fn declines_self_recursive_functions_even_in_isolation() {
        // Run with only this pass enabled: in the full pipeline `f`
        // would be deleted first by dead-function elimination (it's
        // unreachable from any entry point, called only by itself) —
        // that's a different pass's job. This checks the self-
        // recursion guard inside `inline_single_call_functions` itself,
        // which must not try to inline a call site that's inside the
        // candidate's own body.
        let mut opts = crate::golfer::AggressiveOptions::none();
        opts.inline_single_call_functions = true;
        let out = crate::golfer::golf_with_options("float f(float a){return f(a);}void mainImage(out vec4 c,in vec2 p){c=vec4(1.);}", opts).code;
        assert!(out.contains("return"), "self-recursive candidate must decline inlining, got: {out}");
    }

    #[test]
    fn zero_parameter_function_inlines_cleanly() {
        let r = golf("float one(){return 1.;}void mainImage(out vec4 c,in vec2 p){c=vec4(one());}", true);
        assert_eq!(r.code, "void mainImage(out vec4 b,in vec2 c){b=vec4(1.);}");
        assert_eq!(r.stats.aggressive.functions_inlined, 1);
    }

    #[test]
    fn unused_parameter_argument_is_never_silently_dropped() {
        // `b` isn't referenced in the return expression at all; the
        // argument (a bare identifier, side-effect-free) is simply
        // never spliced anywhere, which is fine — nothing observable
        // is lost since it's a bare operand.
        let r = golf(
            "float first(float a,float b){return a;}void mainImage(out vec4 c,in vec2 p){float x=p.x;c=vec4(first(x,x));}",
            true,
        );
        assert_eq!(r.code, "void mainImage(out vec4 c,in vec2 d){float a=d.x;c=vec4(a);}");
        assert_eq!(r.stats.aggressive.functions_inlined, 1);
    }
}
