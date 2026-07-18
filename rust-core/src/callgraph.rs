//! Function call graph (ROADMAP.md Phase 2, "Graphe d'appel de
//! fonctions") — extracted and generalized from the reachability-only
//! logic `eliminate_dead_functions` (ROADMAP.md Phase 1.2) originally
//! built inline for itself. That pass only ever needed "is this
//! function reachable at all", a `HashSet` of callees per caller; this
//! generalizes it to a call *count* per callee (`HashMap` instead of
//! `HashSet`), which reachability doesn't need but the next consumer
//! does: Phase 3.2's single-call-site inlining needs to know a
//! function is called *exactly once* across the whole file, not merely
//! that it's called.
//!
//! `total_calls_to` has no caller yet (Phase 3.2 is what will use it) —
//! see `expr.rs`'s module docs for why landing reusable infrastructure
//! ahead of its first consumer is a deliberate choice here, not an
//! oversight. `reachable_from` already has one: `eliminate_dead_functions`
//! below was refactored to call it instead of keeping its own
//! duplicate copy of the same traversal.

use crate::aggressive::{skip_balanced, Item};
use crate::lexer::Tok;
use std::collections::{HashMap, HashSet};

/// One `<type> <name>(...){...}` found at true top level: `def_start`
/// is the return-type token's index, `body_close` is the closing `}`.
/// Deleting `items[def_start..=body_close]` removes the whole
/// definition, nothing more and nothing less.
pub(crate) struct FunctionDef {
    pub name: String,
    pub def_start: usize,
    pub body_close: usize,
}

/// Scans backward from a `)` at `close_paren` for its matching `(`, or
/// `None` if unbalanced — the mirror image of `skip_balanced`, needed
/// here because a function's parameter list has to be found by
/// walking left from its own body's opening brace.
fn matching_open_paren(items: &[Item], close_paren: usize) -> Option<usize> {
    if !matches!(items.get(close_paren).map(|it| &it.tok), Some(Tok::Punct(')'))) {
        return None;
    }
    let mut depth = 0i32;
    let mut i = close_paren;
    loop {
        match items.get(i).map(|it| &it.tok) {
            Some(Tok::Punct(')')) => depth += 1,
            Some(Tok::Punct('(')) => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            None => return None,
            _ => {}
        }
        if i == 0 {
            return None;
        }
        i -= 1;
    }
}

/// Finds every top-level function definition, in source order. Jumps
/// straight over every top-level `{...}` span it finds (function or
/// not) via `skip_balanced`, so nothing nested inside one is ever
/// independently misidentified as its own top-level definition —
/// mirrors `golfer.rs::top_level_brace_ranges`'s same jump-the-whole-
/// span approach.
pub(crate) fn find_function_definitions(items: &[Item]) -> Vec<FunctionDef> {
    let mut defs = Vec::new();
    let mut i = 0;
    while i < items.len() {
        if matches!(items[i].tok, Tok::Punct('{')) {
            if let Some(close) = skip_balanced(items, i, '{', '}') {
                let body_close = close - 1;
                if i >= 1 {
                    if let Some(open_paren) = matching_open_paren(items, i - 1) {
                        if open_paren >= 2 {
                            let name_idx = open_paren - 1;
                            let type_idx = open_paren - 2;
                            if let (Tok::Ident(name), Tok::Ident(_)) = (&items[name_idx].tok, &items[type_idx].tok) {
                                defs.push(FunctionDef {
                                    name: name.clone(),
                                    def_start: type_idx,
                                    body_close,
                                });
                            }
                        }
                    }
                }
                i = close;
                continue;
            }
        }
        i += 1;
    }
    defs
}

/// caller name -> callee name -> number of times that callee's name
/// appears as an identifier inside the caller's body. Counts every
/// occurrence of the identifier, which would over-count relative to
/// "real function calls" only if the same name could *also* denote a
/// value in the same body — not possible in valid GLSL (a name that
/// resolves to a function can't simultaneously be a variable in the
/// same scope) — the same assumption `eliminate_dead_functions`
/// already relied on before this was extracted.
pub(crate) struct CallGraph {
    edges: HashMap<String, HashMap<String, usize>>,
}

impl CallGraph {
    /// Builds the graph over `defs`, restricted to callees present in
    /// `names` (every recognized function name in the file) — anything
    /// else is a builtin, a variable, or a type name, never a call
    /// this graph needs to reason about.
    pub(crate) fn build(items: &[Item], defs: &[FunctionDef], names: &HashSet<String>) -> Self {
        let mut edges: HashMap<String, HashMap<String, usize>> = HashMap::new();
        for def in defs {
            let entry = edges.entry(def.name.clone()).or_default();
            // `def.def_start + 1` is the function's *own* name token in
            // its signature (`<type> <name>(...)`) — skipped so a
            // function doesn't count as calling itself once just by
            // virtue of declaring itself, which would over-count
            // `total_calls_to` by exactly one per definition.
            let own_name_idx = def.def_start + 1;
            for (idx, item) in items[def.def_start..=def.body_close].iter().enumerate() {
                if def.def_start + idx == own_name_idx {
                    continue;
                }
                if let Tok::Ident(callee) = &item.tok {
                    if names.contains(callee) {
                        *entry.entry(callee.clone()).or_insert(0) += 1;
                    }
                }
            }
        }
        CallGraph { edges }
    }

    /// Every function name reachable from `roots` by following call
    /// edges transitively (`roots` themselves included) — exactly the
    /// traversal `eliminate_dead_functions` needs to find unreachable
    /// definitions.
    pub(crate) fn reachable_from(&self, roots: &[String]) -> HashSet<String> {
        let mut reachable: HashSet<String> = HashSet::new();
        let mut queue: Vec<String> = roots.to_vec();
        while let Some(name) = queue.pop() {
            if !reachable.insert(name.clone()) {
                continue;
            }
            if let Some(callees) = self.edges.get(&name) {
                for callee in callees.keys() {
                    if !reachable.contains(callee) {
                        queue.push(callee.clone());
                    }
                }
            }
        }
        reachable
    }

    /// Total number of call sites targeting `name`, summed across
    /// every caller in the graph — e.g. exactly 1 is the precondition
    /// Phase 3.2's single-call-site inlining needs. Deliberately
    /// whole-graph rather than "from reachable callers only": that
    /// distinction is the caller's to make (e.g. by building the graph
    /// only from already-reachable defs in the first place), not this
    /// method's to guess at.
    #[allow(dead_code)]
    pub(crate) fn total_calls_to(&self, name: &str) -> usize {
        self.edges.values().map(|callees| callees.get(name).copied().unwrap_or(0)).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::tokenize_spaced;

    fn items_from(src: &str) -> Vec<Item> {
        tokenize_spaced(src)
            .into_iter()
            .map(|(tok, space_before)| {
                let text = match &tok {
                    Tok::Ident(s) | Tok::Number(s) | Tok::Preproc(s) => s.clone(),
                    Tok::Punct(c) => c.to_string(),
                };
                Item { tok, text, space_before }
            })
            .collect()
    }

    #[test]
    fn counts_multiple_calls_to_the_same_function() {
        let items = items_from("void helper(){}void mainImage(){helper();helper();helper();}");
        let defs = find_function_definitions(&items);
        let names: HashSet<String> = defs.iter().map(|d| d.name.clone()).collect();
        let graph = CallGraph::build(&items, &defs, &names);
        assert_eq!(graph.total_calls_to("helper"), 3);
        assert_eq!(graph.total_calls_to("mainImage"), 0);
    }

    #[test]
    fn sums_calls_across_multiple_distinct_callers() {
        let items = items_from(
            "void helper(){}void a(){helper();}void b(){helper();helper();}void mainImage(){a();b();}",
        );
        let defs = find_function_definitions(&items);
        let names: HashSet<String> = defs.iter().map(|d| d.name.clone()).collect();
        let graph = CallGraph::build(&items, &defs, &names);
        assert_eq!(graph.total_calls_to("helper"), 3);
        assert_eq!(graph.total_calls_to("a"), 1);
        assert_eq!(graph.total_calls_to("b"), 1);
    }

    #[test]
    fn reachable_from_matches_transitive_call_chain() {
        let items = items_from("void deadFn(){}void a(){}void b(){a();}void mainImage(){b();}");
        let defs = find_function_definitions(&items);
        let names: HashSet<String> = defs.iter().map(|d| d.name.clone()).collect();
        let graph = CallGraph::build(&items, &defs, &names);
        let reachable = graph.reachable_from(&["mainImage".to_string()]);
        assert!(reachable.contains("mainImage"));
        assert!(reachable.contains("b"));
        assert!(reachable.contains("a"));
        assert!(!reachable.contains("deadFn"));
    }

    #[test]
    fn unreached_functions_have_zero_total_calls() {
        let items = items_from("void deadFn(){}void mainImage(){}");
        let defs = find_function_definitions(&items);
        let names: HashSet<String> = defs.iter().map(|d| d.name.clone()).collect();
        let graph = CallGraph::build(&items, &defs, &names);
        assert_eq!(graph.total_calls_to("deadFn"), 0);
    }
}
