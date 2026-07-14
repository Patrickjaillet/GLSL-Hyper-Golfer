//! Optional "aggressive golf" passes — applied *after* the safe
//! rename/number/layout pipeline, and only when explicitly requested.
//!
//! Unlike the safe pipeline (which only ever changes spelling, never
//! program structure), these passes rewrite statement shape. Each one
//! is scoped tightly enough to be provably value-preserving rather than
//! "usually fine": see the comment on each function for exactly which
//! inputs it declines to touch and why.

use crate::lexer::Tok;
use crate::vocab::type_keywords;
use std::collections::HashMap;

#[derive(Clone)]
pub struct Item {
    pub tok: Tok,
    pub text: String,
    pub space_before: bool,
}

#[derive(Default, Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggressiveStats {
    pub compound_assignments: usize,
    pub declarations_merged: usize,
    pub braces_removed: usize,
    pub constants_folded: usize,
    pub dead_locals_removed: usize,
    pub dead_stores_removed: usize,
    pub constant_vectors_reduced: usize,
    pub trailing_void_returns_removed: usize,
    pub increments_decrements: usize,
    pub ternaries_from_if_else: usize,
}

fn is_unary_prefix(c: char) -> bool {
    matches!(c, '-' | '+' | '!' | '~')
}

fn find_ident(items: &[Item], i: usize) -> Option<&str> {
    match items.get(i).map(|it| &it.tok) {
        Some(Tok::Ident(s)) => Some(s.as_str()),
        _ => None,
    }
}

// ---------------------------------------------------------------------
// Dead local elimination — deliberately the narrowest possible slice of
// "dead code elimination": drops a local declaration only when the
// declared name appears *nowhere else at all* in the file (so it's
// never read, never reassigned — there is nothing to preserve), and
// its initializer (if any) is a single identifier or number literal
// with no function call, member access, or side effect of any kind.
//
// A real "eliminate variables that are written but never read" pass
// would need genuine data-flow analysis — reassignments, branches,
// loops, `out`/`inout` parameters aliasing the variable, and function
// calls that might have side effects all have to be accounted for
// correctly, or the pass deletes code that mattered. This narrower
// version sidesteps all of that: a name used exactly once, at its own
// declaration, with a side-effect-free initializer, can never be
// observed regardless of control flow, so removing it is safe by
// construction rather than by careful-but-fallible analysis.
// ---------------------------------------------------------------------

fn is_bare_operand(items: &[Item], idx: usize) -> bool {
    matches!(items.get(idx).map(|it| &it.tok), Some(Tok::Ident(_)) | Some(Tok::Number(_)))
}

/// If the declaration statement starting at `start` is a plain local
/// (no qualifier — `type_keywords()` excludes `uniform`/`const`/etc, so
/// only unqualified locals ever match) whose name occurs exactly once
/// in the whole file and whose initializer, if any, is a single bare
/// identifier or number literal (never a function call — `foo(x)`
/// fails because the token right after the bare `foo` operand would
/// have to be `;` and it's `(` instead), returns the index just past
/// its terminating `;` so the caller can drop the whole statement.
/// Returns `None` for anything else (array declarators, multi-token
/// initializers, names used elsewhere, ...) — decline rather than risk
/// removing something that matters.
fn try_remove_dead_decl(
    items: &[Item],
    start: usize,
    type_kw: &std::collections::HashSet<&'static str>,
    freq: &HashMap<String, usize>,
) -> Option<usize> {
    let t = find_ident(items, start)?;
    if !type_kw.contains(t) {
        return None;
    }
    let name = find_ident(items, start + 1)?;
    if freq.get(name).copied().unwrap_or(0) != 1 {
        return None;
    }

    match items.get(start + 2).map(|it| &it.tok) {
        Some(Tok::Punct(';')) => Some(start + 3),
        Some(Tok::Punct('=')) => {
            let mut i = start + 3;
            if let Some(Tok::Punct(c)) = items.get(i).map(|it| &it.tok) {
                if is_unary_prefix(*c) {
                    i += 1;
                }
            }
            if !is_bare_operand(items, i) {
                return None;
            }
            i += 1;
            match items.get(i).map(|it| &it.tok) {
                Some(Tok::Punct(';')) => Some(i + 1),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Drops dead local declarations wherever `try_remove_dead_decl` finds
/// one at a statement boundary (right after `;`, `{`, `}`, or file
/// start — the same boundary test `merge_declarations` uses, which
/// already correctly excludes a `for(...)` header's own declaration:
/// the token right before it is `(`, never a boundary marker).
pub fn eliminate_dead_locals(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let type_kw = type_keywords();
    let mut freq: HashMap<String, usize> = HashMap::new();
    for it in &items {
        if let Tok::Ident(name) = &it.tok {
            *freq.entry(name.clone()).or_insert(0) += 1;
        }
    }

    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut i = 0;
    while i < items.len() {
        let at_boundary = out
            .last()
            .is_none_or(|it: &Item| matches!(it.tok, Tok::Punct(';') | Tok::Punct('{') | Tok::Punct('}')));

        if at_boundary {
            if let Some(end) = try_remove_dead_decl(&items, i, type_kw, &freq) {
                stats.dead_locals_removed += 1;
                i = end;
                continue;
            }
        }

        out.push(items[i].clone());
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------
// Dead store elimination — a second, complementary slice of "dead code
// elimination", distinct from `eliminate_dead_locals` above: that one
// handles a variable that's declared and *never referenced again at
// all*; this one handles a variable that's written, then **immediately**
// overwritten by the very next statement with no read in between —
// `float x=1.;x=2.;` — where the first write is dead even though `x`
// itself is very much still used later.
//
// Scope is deliberately narrow: only *directly adjacent* statement
// pairs are considered, at bracket/paren depth 0 (so a for-header's own
// `int i=0;` clause is never mistaken for a real statement — see the
// depth tracking in `eliminate_dead_stores`). A dead store separated
// from its superseding write by any other statement, or by a
// branch/loop, is not caught — proving liveness across control flow
// needs real data-flow analysis, which this intentionally doesn't
// attempt. Catching only immediately-adjacent pairs sidesteps that
// entirely: there is no other code path between the two statements for
// the first write's value to have been observed on, so overwriting it
// is safe *by construction*, not by reasoning about control flow.
// ---------------------------------------------------------------------

struct SimpleWrite {
    is_decl: bool,
    name: String,
    /// The identifier the RHS reads, if the RHS is a (possibly
    /// unary-prefixed) bare identifier — used to refuse eliminating a
    /// write whose *own* superseding statement reads it first (`x=1.;
    /// x=x;` must not become `x=x;` with the prior value lost; it must
    /// stay as two statements, since the second one's value now depends
    /// on the first having run).
    rhs_ident: Option<String>,
    start: usize,
    end: usize,
}

/// Parses `[<type>] <ident> = <bare operand>;` starting at `start` —
/// a plain assignment or a declaration with a trivial initializer.
/// Returns `None` for anything else (compound RHS, function calls,
/// compound-assignment operators, array/member targets, ...): those are
/// always left alone rather than risk reasoning incorrectly about them.
fn parse_simple_write(items: &[Item], start: usize) -> Option<SimpleWrite> {
    let type_kw = type_keywords();
    let mut i = start;
    let is_decl = matches!(find_ident(items, i), Some(t) if type_kw.contains(t));
    if is_decl {
        i += 1;
    }
    let name = find_ident(items, i)?.to_string();
    i += 1;
    if !matches!(items.get(i).map(|it| &it.tok), Some(Tok::Punct('='))) {
        return None;
    }
    i += 1;
    if let Some(Tok::Punct(c)) = items.get(i).map(|it| &it.tok) {
        if is_unary_prefix(*c) {
            i += 1;
        }
    }
    let rhs_ident = match items.get(i).map(|it| &it.tok) {
        Some(Tok::Ident(n)) => Some(n.clone()),
        Some(Tok::Number(_)) => None,
        _ => return None,
    };
    i += 1;
    if !matches!(items.get(i).map(|it| &it.tok), Some(Tok::Punct(';'))) {
        return None;
    }
    Some(SimpleWrite {
        is_decl,
        name,
        rhs_ident,
        start,
        end: i + 1,
    })
}

/// Drops a simple write when the *very next* statement is a plain
/// (non-declaring) simple write to the same name that doesn't itself
/// read that name — see the module docs above. A declaration's write is
/// reduced to a bare `<type> <ident>;` rather than dropped outright
/// (its declaration must survive; only the wasted initial value dies).
pub fn eliminate_dead_stores(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut i = 0;
    // Only ever matched at paren/bracket depth 0, so a for-header's own
    // `int i=0;i<9;i++` (or any other expression-context `;`) is never
    // mistaken for a real statement boundary — those live at depth > 0
    // from the moment their enclosing `(` is seen.
    let mut depth = 0i32;
    while i < items.len() {
        if depth == 0 {
            if let Some(write) = parse_simple_write(&items, i) {
                if let Some(next) = parse_simple_write(&items, write.end) {
                    let self_referencing = next.rhs_ident.as_deref() == Some(write.name.as_str());
                    if !next.is_decl && next.name == write.name && !self_referencing {
                        stats.dead_stores_removed += 1;
                        if write.is_decl {
                            out.push(items[write.start].clone());
                            out.push(items[write.start + 1].clone());
                            out.push(Item {
                                tok: Tok::Punct(';'),
                                text: ";".to_string(),
                                space_before: false,
                            });
                        }
                        i = write.end;
                        continue;
                    }
                }
            }
        }
        match items[i].tok {
            Tok::Punct('(') | Tok::Punct('[') => depth += 1,
            Tok::Punct(')') | Tok::Punct(']') => depth -= 1,
            _ => {}
        }
        out.push(items[i].clone());
        i += 1;
    }
    out
}

/// Consumes one balanced `(...)` / `[...]` / `{...}` group starting at
/// `open`, which must point *at* the opening bracket (checked — returns
/// `None` immediately otherwise, so callers can `?` this without a
/// separate precondition check), and returns the index just past the
/// matching close, or `None` if the brackets never close (malformed
/// input — leave it alone rather than guess).
fn skip_balanced(items: &[Item], open: usize, open_c: char, close_c: char) -> Option<usize> {
    match items.get(open).map(|it| &it.tok) {
        Some(Tok::Punct(c)) if *c == open_c => {}
        _ => return None,
    }
    let mut depth = 0i32;
    let mut i = open;
    loop {
        match items.get(i).map(|it| &it.tok) {
            Some(Tok::Punct(c)) if *c == open_c => depth += 1,
            Some(Tok::Punct(c)) if *c == close_c => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            None => return None,
            _ => {}
        }
        i += 1;
    }
}

/// Consumes exactly one primary expression (an identifier or numeric
/// literal, optionally wrapped in unary prefixes and/or followed by a
/// postfix chain of `.member`, `[index]`, `(call args)`), and returns
/// the index just past it. Returns `None` if what follows isn't a
/// single self-contained term — e.g. a bare `+`/`-`/`*`/`/` at the top
/// level, which would mean there's more than one term and folding it
/// into a compound-assignment RHS could silently change the value
/// (`a = a - b - c` is not `a -= b - c`; see `try_compound_assign`).
fn scan_primary(items: &[Item], start: usize) -> Option<usize> {
    let mut i = start;
    while let Some(Tok::Punct(c)) = items.get(i).map(|it| &it.tok) {
        if is_unary_prefix(*c) {
            i += 1;
        } else {
            break;
        }
    }
    match items.get(i).map(|it| &it.tok) {
        Some(Tok::Ident(_)) | Some(Tok::Number(_)) => i += 1,
        Some(Tok::Punct('(')) => i = skip_balanced(items, i, '(', ')')?,
        _ => return None,
    }
    loop {
        match items.get(i).map(|it| &it.tok) {
            Some(Tok::Punct('.')) => {
                if matches!(items.get(i + 1).map(|it| &it.tok), Some(Tok::Ident(_))) {
                    i += 2;
                } else {
                    return None;
                }
            }
            Some(Tok::Punct('[')) => i = skip_balanced(items, i, '[', ']')?,
            Some(Tok::Punct('(')) => i = skip_balanced(items, i, '(', ')')?,
            _ => break,
        }
    }
    Some(i)
}

// ---------------------------------------------------------------------
// Constant folding — restricted to plain (unsuffixed, non-hex) integer
// literals combined with `*`, `/` or `%`.
//
// This is deliberately much narrower than "fold any constant
// expression": float folding is skipped entirely because GLSL floats
// may run in `mediump` (or even lower) precision on the GPU, and a
// value we compute host-side in full precision and print back as a
// decimal literal is not guaranteed to re-round to the same bits the
// GPU would have produced evaluating the original expression itself —
// a real, silent correctness risk for no benefit worth taking.
// Integers have no such problem (GLSL `int` is exact 32-bit two's
// complement, and so is the arithmetic below).
//
// `+`/`-` are also skipped: unlike `*`/`/`/`%` (already the tightest
// arithmetic precedence in GLSL, so folding them can never change how
// an expression groups), folding a `+`/`-` pair would require checking
// that neither neighbour is a `*`/`/`/`%` about to claim one of the
// operands first (`2+3*4` is `2+(3*4)`, not `(2+3)*4`) — a precedence
// analysis this pass doesn't do, so it declines rather than risk it.
// ---------------------------------------------------------------------

const FOLDABLE_OPS: &[char] = &['*', '/', '%'];

/// Parses `raw` as a plain base-10 integer literal (no hex prefix, no
/// decimal point/exponent, no `u`/`f` type suffix) — anything else
/// returns `None` so the caller leaves it untouched.
fn parse_plain_int(raw: &str) -> Option<i64> {
    if raw.is_empty() || raw.starts_with("0x") || raw.starts_with("0X") {
        return None;
    }
    if !raw.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    raw.parse::<i64>().ok()
}

/// Evaluates `a <op> b` with GLSL `int` (32-bit signed, truncating
/// division) semantics, returning `None` on overflow or division/
/// modulo by zero rather than guess at what the shader compiler would
/// do — declining to fold is always safe, folding to the wrong value
/// silently isn't.
fn fold_int_op(a: i64, op: char, b: i64) -> Option<i64> {
    let result = match op {
        '*' => a.checked_mul(b)?,
        '/' => {
            if b == 0 || (a == i32::MIN as i64 && b == -1) {
                return None;
            }
            a / b // Rust truncates toward zero for integers, matching GLSL.
        }
        '%' => {
            if b == 0 {
                return None;
            }
            a % b
        }
        _ => return None,
    };
    if result < i32::MIN as i64 || result > i32::MAX as i64 {
        return None;
    }
    Some(result)
}

/// Folds `<int> <op> <int>` into a single literal wherever the two
/// numbers are directly adjacent to the operator in the token stream —
/// which, since numeric literals are themselves primary expressions,
/// is exactly the condition under which they're guaranteed to be
/// combined by that operator in the parsed expression regardless of
/// anything else around them. Re-checks the freshly folded literal
/// against what follows so a chain like `2*3*4` folds all the way to
/// `24` in one pass (`*`/`/`/`%` are left-associative, so folding
/// greedily left-to-right matches GLSL's own evaluation order).
pub fn fold_constants(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut i = 0;
    while i < items.len() {
        let left = match out.last() {
            Some(Item {
                tok: Tok::Number(raw),
                ..
            }) => parse_plain_int(raw),
            _ => None,
        };
        let op = match (left, items.get(i).map(|it| &it.tok)) {
            (Some(_), Some(Tok::Punct(c))) if FOLDABLE_OPS.contains(c) => Some(*c),
            _ => None,
        };
        let right = match (op, items.get(i + 1).map(|it| &it.tok)) {
            (Some(_), Some(Tok::Number(raw))) => parse_plain_int(raw),
            _ => None,
        };

        if let (Some(a), Some(op), Some(b)) = (left, op, right) {
            if let Some(value) = fold_int_op(a, op, b) {
                out.pop();
                let text = value.to_string();
                out.push(Item {
                    tok: Tok::Number(text.clone()),
                    text,
                    space_before: false,
                });
                stats.constants_folded += 1;
                i += 2;
                continue;
            }
        }

        out.push(items[i].clone());
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------
// Constant vector reduction — `vec3(1.,1.,1.)` -> `vec3(1.)`. Safe by
// the GLSL spec itself, not a heuristic: a vector constructor called
// with a single scalar argument broadcasts that value to every
// component, which is *by definition* the same value the N-argument
// form produces when all N arguments are identical. Restricted to
// vec2/vec3/vec4 with plain numeric literal arguments (never ivec/
// uvec/bvec, never an expression like `1.+0.` — only a bare `Number`
// token) so this is a pure token-count-and-text-equality check, no
// expression evaluation needed: every argument must be the exact same
// token text, which the shortened-number pass upstream already made
// canonical (two literals that mean the same value produce the same
// text), so text equality is exactly the right check, not just an
// approximation of it. Deliberately does not attempt negative literals
// (`-1.` tokenizes as `Punct('-')` then `Number("1.")`, not a single
// token) — narrower coverage, but avoids having to reason about unary
// minus placement at all.
fn vec_arity(name: &str) -> Option<usize> {
    match name {
        "vec2" => Some(2),
        "vec3" => Some(3),
        "vec4" => Some(4),
        _ => None,
    }
}

/// If `items[i..]` is `vecN(<lit>,<lit>,...,<lit>)` with exactly N
/// identical numeric-literal arguments, returns the index of the
/// closing `)` and the index of the (first) literal to keep.
fn try_match_constant_vector(items: &[Item], i: usize) -> Option<(usize, usize)> {
    let arity = vec_arity(find_ident(items, i)?)?;
    if !matches!(items.get(i + 1).map(|it| &it.tok), Some(Tok::Punct('('))) {
        return None;
    }
    let mut idx = i + 2;
    let mut first_text: Option<&str> = None;
    let mut first_idx = None;
    for k in 0..arity {
        match items.get(idx).map(|it| &it.tok) {
            Some(Tok::Number(_)) => {}
            _ => return None,
        }
        let text = items[idx].text.as_str();
        match first_text {
            Some(ft) if ft != text => return None,
            Some(_) => {}
            None => {
                first_text = Some(text);
                first_idx = Some(idx);
            }
        }
        idx += 1;
        if k + 1 < arity {
            if !matches!(items.get(idx).map(|it| &it.tok), Some(Tok::Punct(','))) {
                return None;
            }
            idx += 1;
        }
    }
    if !matches!(items.get(idx).map(|it| &it.tok), Some(Tok::Punct(')'))) {
        return None;
    }
    Some((idx, first_idx.unwrap()))
}

pub fn reduce_constant_vectors(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut i = 0;
    while i < items.len() {
        if let Some((close_idx, value_idx)) = try_match_constant_vector(&items, i) {
            out.push(items[i].clone());
            out.push(items[i + 1].clone());
            out.push(items[value_idx].clone());
            out.push(items[close_idx].clone());
            stats.constant_vectors_reduced += 1;
            i = close_idx + 1;
            continue;
        }
        out.push(items[i].clone());
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------
// Trailing void-return elision — `void f(){ ...; return; }` ->
// `void f(){ ...; }`. Falling off the end of a `void` function is
// spec-equivalent to an explicit bare `return;`, so a `return;` that is
// genuinely the function body's own final statement can always be
// dropped.
//
// The trap this has to avoid: `if(x)return;}` (an *unbraced* `if`
// clause whose single-statement body happens to be the function's last
// statement) looks token-wise identical to a real standalone `return;`
// right before the closing `}` — but `if` syntactically requires some
// statement to follow it, so blindly deleting `return;` here would
// leave `if(x)}`, invalid GLSL. Guarded against by requiring `return`
// itself to be immediately preceded by a statement/block boundary
// (`;`, `{`, `}`, or the start of the token stream) — the same
// boundary convention `eliminate_dead_locals`/`eliminate_dead_stores`
// use — which `if(x)return;` fails (preceded by `)`), so it's correctly
// left alone.
// ---------------------------------------------------------------------

/// Token indices of every `}` that closes a top-level `void <name>(...) { ... }` function body.
fn void_function_body_closers(items: &[Item]) -> std::collections::HashSet<usize> {
    let mut closers = std::collections::HashSet::new();
    let mut i = 0;
    while i < items.len() {
        let is_void = matches!(&items[i].tok, Tok::Ident(s) if s == "void");
        if is_void && matches!(items.get(i + 1).map(|it| &it.tok), Some(Tok::Ident(_))) {
            if let Some(Tok::Punct('(')) = items.get(i + 2).map(|it| &it.tok) {
                let mut depth = 0i32;
                let mut k = i + 2;
                loop {
                    match items.get(k).map(|it| &it.tok) {
                        Some(Tok::Punct('(')) => depth += 1,
                        Some(Tok::Punct(')')) => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        None => break,
                        _ => {}
                    }
                    k += 1;
                }
                if matches!(items.get(k + 1).map(|it| &it.tok), Some(Tok::Punct('{'))) {
                    let mut bd = 0i32;
                    let mut m = k + 1;
                    loop {
                        match items.get(m).map(|it| &it.tok) {
                            Some(Tok::Punct('{')) => bd += 1,
                            Some(Tok::Punct('}')) => {
                                bd -= 1;
                                if bd == 0 {
                                    closers.insert(m);
                                    break;
                                }
                            }
                            None => break,
                            _ => {}
                        }
                        m += 1;
                    }
                    i = m;
                    continue;
                }
            }
        }
        i += 1;
    }
    closers
}

fn is_statement_boundary(items: &[Item], idx: usize) -> bool {
    if idx == 0 {
        return true;
    }
    matches!(items.get(idx - 1).map(|it| &it.tok), Some(Tok::Punct(';')) | Some(Tok::Punct('{')) | Some(Tok::Punct('}')))
}

pub fn strip_trailing_void_return(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let closers = void_function_body_closers(&items);
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut i = 0;
    while i < items.len() {
        let is_return = matches!(&items[i].tok, Tok::Ident(s) if s == "return");
        if is_return
            && is_statement_boundary(&items, i)
            && matches!(items.get(i + 1).map(|it| &it.tok), Some(Tok::Punct(';')))
            && closers.contains(&(i + 2))
        {
            stats.trailing_void_returns_removed += 1;
            i += 2;
            continue;
        }
        out.push(items[i].clone());
        i += 1;
    }
    out
}

const STATEMENT_TERMINATORS: &[char] = &[';', ',', ')', ']', '}'];

fn is_terminator(items: &[Item], idx: usize) -> bool {
    match items.get(idx).map(|it| &it.tok) {
        None => true, // end of file also ends a statement
        Some(Tok::Punct(c)) => STATEMENT_TERMINATORS.contains(c),
        _ => false,
    }
}

/// Rewrites `a = a <op> <single term>;` into `a <op>= <single term>;`.
///
/// This only fires when the right-hand side is *exactly one* primary
/// expression — never a longer `+`/`-`/`*`/`/` chain — because that's
/// the only case where wrapping it in the implicit parentheses of a
/// compound assignment can never change the result: `a - (term)` and
/// `a - term` are the same expression by construction (no operator
/// after `term` to reassociate with). A longer chain would not be safe
/// in general (`a - b - c` != `a -= (b - c)`), so it's intentionally
/// left untouched rather than risk a silent value change.
pub fn compound_assignments(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let type_kw = type_keywords();
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut i = 0;
    while i < items.len() {
        let matches_pattern = if let (
            Some(Tok::Ident(a)),
            Some(Tok::Punct('=')),
            Some(Tok::Ident(a2)),
            Some(Tok::Punct(op)),
        ) = (
            items.get(i).map(|it| &it.tok),
            items.get(i + 1).map(|it| &it.tok),
            items.get(i + 2).map(|it| &it.tok),
            items.get(i + 3).map(|it| &it.tok),
        ) {
            let op = *op;
            a == a2 && matches!(op, '+' | '-' | '*' | '/' | '%')
        } else {
            false
        };

        if matches_pattern {
            // Refuse to touch a self-initializing declarator like
            // `float a=a+1;` — rewriting to `float a+=1;` isn't valid
            // GLSL syntax at all, so bail if the token right before `a`
            // is a type keyword.
            let is_declarator = i > 0
                && matches!(&items[i - 1].tok, Tok::Ident(prev) if type_kw.contains(prev.as_str()));

            if !is_declarator {
                let op = match items[i + 3].tok {
                    Tok::Punct(c) => c,
                    _ => unreachable!(),
                };
                if let Some(end) = scan_primary(&items, i + 4) {
                    if is_terminator(&items, end) {
                        out.push(items[i].clone()); // `a`
                        out.push(Item {
                            tok: Tok::Punct(op),
                            text: op.to_string(),
                            space_before: false,
                        });
                        out.push(Item {
                            tok: Tok::Punct('='),
                            text: "=".to_string(),
                            space_before: false,
                        });
                        out.extend_from_slice(&items[i + 4..end]);
                        stats.compound_assignments += 1;
                        i = end;
                        continue;
                    }
                }
            }
        }

        out.push(items[i].clone());
        i += 1;
    }
    out
}

/// Rewrites `a += 1;` / `a -= 1;` into the prefix form `++a;` / `--a;`,
/// saving one character. Meant to run right after `compound_assignments`
/// so `a = a + 1;` (already folded to `a += 1;` by then) benefits too.
///
/// Deliberately **prefix**, never postfix: this rewrite also fires when
/// the compound assignment is itself a sub-expression whose value is
/// read (`foo(a += 1)`, valid GLSL — assignment is an expression) —
/// `a += 1` evaluates to the *new* value of `a`, and prefix `++a` is
/// defined to do exactly the same, whereas postfix `a++` would silently
/// change the value seen by anything reading the expression's result.
/// The only cases fired at all are where the increment amount is
/// *exactly* `1`: matched on `Item::text` (the already-shortened output
/// form — `1.0` becomes `1.` upstream before this pass ever runs, so
/// matching on `.text` rather than the untouched `.tok` raw string is
/// what makes the `"1."` check actually hit), never `1u`/`1.0f`/`1e0`
/// (those shorten to `1u`/`1.f`/unchanged-with-exponent respectively —
/// deliberately outside this narrow match rather than special-cased).
pub fn increment_decrement(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut i = 0;
    while i < items.len() {
        let op = match (
            items.get(i).map(|it| &it.tok),
            items.get(i + 1).map(|it| &it.tok),
            items.get(i + 2).map(|it| &it.tok),
            items.get(i + 3).map(|it| &it.tok),
        ) {
            (Some(Tok::Ident(_)), Some(Tok::Punct(op @ ('+' | '-'))), Some(Tok::Punct('=')), Some(Tok::Number(_))) => Some(*op),
            _ => None,
        };

        if let Some(op) = op {
            let value_text = items[i + 3].text.as_str();
            if (value_text == "1" || value_text == "1.") && is_terminator(&items, i + 4) {
                out.push(Item {
                    tok: Tok::Punct(op),
                    text: op.to_string(),
                    space_before: items[i].space_before,
                });
                out.push(Item {
                    tok: Tok::Punct(op),
                    text: op.to_string(),
                    space_before: false,
                });
                out.push(Item {
                    tok: items[i].tok.clone(),
                    text: items[i].text.clone(),
                    space_before: false,
                });
                stats.increments_decrements += 1;
                i += 4;
                continue;
            }
        }

        out.push(items[i].clone());
        i += 1;
    }
    out
}

struct TernaryMatch {
    end: usize,
    ident_idx: usize,
    cond: (usize, usize),
    x: (usize, usize),
    y: (usize, usize),
}

/// Matches `if ( COND ) A = X ; else A = Y ;` (braces around either arm
/// optional, and required to wrap a single statement if present) at
/// `i`, where `A` is the exact same identifier on both sides. Returns
/// the spans needed to rebuild it as `A = (COND) ? X : Y ;`.
///
/// `X`/`Y` are each restricted to a single `scan_primary` term — same
/// restriction `compound_assignments` places on its right-hand side,
/// for the same reason: anything longer risks reassociating unsafely
/// once moved next to `?`/`:`. `COND` has no such restriction because
/// it is never re-scanned for structure at all: `try_match_ternary`
/// only finds where it starts and ends (via the same `skip_balanced`
/// paren-tracker used elsewhere), and the caller splices those tokens
/// back out **wrapped in a fresh pair of parens**. That side-steps
/// every precedence question a bare splice would raise — e.g. if COND
/// itself contained a top-level `?:`, splicing it unparenthesized
/// would silently reassociate with the new `?:` being added (`?:` is
/// right-associative, so `a?b:c?x:y` parses as `a?b:(c?x:y)`, not the
/// intended `(a?b:c)?x:y`). Wrapping in `(COND)` costs two characters
/// and makes the question moot regardless of what COND contains.
fn try_match_ternary(items: &[Item], i: usize) -> Option<TernaryMatch> {
    if !matches!(&items.get(i)?.tok, Tok::Ident(s) if s == "if") {
        return None;
    }
    if !is_statement_boundary(items, i) {
        return None;
    }
    if !matches!(items.get(i + 1).map(|it| &it.tok), Some(Tok::Punct('('))) {
        return None;
    }
    let cond_start = i + 2;
    let after_paren = skip_balanced(items, i + 1, '(', ')')?;
    let cond_end = after_paren - 1;

    let mut j = after_paren;
    let braced1 = matches!(items.get(j).map(|it| &it.tok), Some(Tok::Punct('{')));
    if braced1 {
        j += 1;
    }
    let ident_idx = j;
    let name1 = match items.get(ident_idx).map(|it| &it.tok) {
        Some(Tok::Ident(s)) => s.clone(),
        _ => return None,
    };
    if !matches!(items.get(ident_idx + 1).map(|it| &it.tok), Some(Tok::Punct('='))) {
        return None;
    }
    // Excludes `==` (a comparison, not an assignment) landing here.
    if matches!(items.get(ident_idx + 2).map(|it| &it.tok), Some(Tok::Punct('='))) {
        return None;
    }
    let x_start = ident_idx + 2;
    let x_end = scan_primary(items, x_start)?;
    if !matches!(items.get(x_end).map(|it| &it.tok), Some(Tok::Punct(';'))) {
        return None;
    }
    let mut k = x_end + 1;
    if braced1 {
        if !matches!(items.get(k).map(|it| &it.tok), Some(Tok::Punct('}'))) {
            return None;
        }
        k += 1;
    }

    if !matches!(&items.get(k)?.tok, Tok::Ident(s) if s == "else") {
        return None;
    }
    k += 1;
    let braced2 = matches!(items.get(k).map(|it| &it.tok), Some(Tok::Punct('{')));
    if braced2 {
        k += 1;
    }
    let ident2_idx = k;
    match items.get(ident2_idx).map(|it| &it.tok) {
        Some(Tok::Ident(s)) if *s == name1 => {}
        _ => return None,
    }
    if !matches!(items.get(ident2_idx + 1).map(|it| &it.tok), Some(Tok::Punct('='))) {
        return None;
    }
    if matches!(items.get(ident2_idx + 2).map(|it| &it.tok), Some(Tok::Punct('='))) {
        return None;
    }
    let y_start = ident2_idx + 2;
    let y_end = scan_primary(items, y_start)?;
    if !matches!(items.get(y_end).map(|it| &it.tok), Some(Tok::Punct(';'))) {
        return None;
    }
    let mut end = y_end + 1;
    if braced2 {
        if !matches!(items.get(end).map(|it| &it.tok), Some(Tok::Punct('}'))) {
            return None;
        }
        end += 1;
    }

    Some(TernaryMatch { end, ident_idx, cond: (cond_start, cond_end), x: (x_start, x_end), y: (y_start, y_end) })
}

pub fn ternary_from_if_else(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut i = 0;
    while i < items.len() {
        if let Some(m) = try_match_ternary(&items, i) {
            out.push(items[m.ident_idx].clone());
            out.push(Item { tok: Tok::Punct('='), text: "=".to_string(), space_before: false });
            out.push(Item { tok: Tok::Punct('('), text: "(".to_string(), space_before: false });
            out.extend_from_slice(&items[m.cond.0..m.cond.1]);
            out.push(Item { tok: Tok::Punct(')'), text: ")".to_string(), space_before: false });
            out.push(Item { tok: Tok::Punct('?'), text: "?".to_string(), space_before: false });
            out.extend_from_slice(&items[m.x.0..m.x.1]);
            out.push(Item { tok: Tok::Punct(':'), text: ":".to_string(), space_before: false });
            out.extend_from_slice(&items[m.y.0..m.y.1]);
            out.push(Item { tok: Tok::Punct(';'), text: ";".to_string(), space_before: false });
            stats.ternaries_from_if_else += 1;
            i = m.end;
            continue;
        }
        out.push(items[i].clone());
        i += 1;
    }
    out
}

/// Merges adjacent declaration statements of the identical type keyword
/// into one comma-separated declaration:
/// `float a=1.;float b=2.;` -> `float a=1.,b=2.;`.
///
/// Only fires when the second statement starts with the *exact same*
/// type keyword as the one currently open, immediately followed by a
/// declarator identifier — in GLSL a bare `type identifier` pair at
/// statement position is unambiguously a declaration (constructor calls
/// like `vec3(...)` are always followed by `(`, never by a bare name),
/// so there's no risk of merging into something that wasn't a
/// declaration. Tracking resets on any statement that isn't itself a
/// fresh same-type declaration, so unrelated statements in between
/// (`float a=1.; x=2.; float b=3.;`) are never bridged.
pub fn merge_declarations(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let type_kw = type_keywords();
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut pending_type: Option<String> = None;
    let mut i = 0;

    while i < items.len() {
        let at_boundary = out
            .last()
            .is_none_or(|it: &Item| matches!(it.tok, Tok::Punct(';') | Tok::Punct('{') | Tok::Punct('}')));

        if at_boundary {
            let decl_start = if let (Some(Tok::Ident(t)), Some(Tok::Ident(_))) = (
                items.get(i).map(|it| &it.tok),
                items.get(i + 1).map(|it| &it.tok),
            ) {
                if type_kw.contains(t.as_str()) {
                    Some(t.clone())
                } else {
                    None
                }
            } else {
                None
            };

            if let Some(t) = decl_start {
                let can_merge = pending_type.as_deref() == Some(t.as_str())
                    && matches!(out.last().map(|it| &it.tok), Some(Tok::Punct(';')));
                if can_merge {
                    out.pop(); // drop the ';'
                    out.push(Item {
                        tok: Tok::Punct(','),
                        text: ",".to_string(),
                        space_before: false,
                    });
                    stats.declarations_merged += 1;
                    i += 1; // skip the repeated type keyword; declarator ident follows normally
                    continue;
                } else {
                    pending_type = Some(t);
                    out.push(items[i].clone());
                    i += 1;
                    continue;
                }
            } else {
                pending_type = None;
            }
        }

        out.push(items[i].clone());
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------
// Redundant-brace removal (`if(x){y=1;}` -> `if(x)y=1;`)
//
// GLSL, like C, makes the braces around the body of `if`/`else`/`for`/
// `while` optional when that body is a single statement. Removing them
// is *the* classic shader-golfing move — but doing it wrong produces
// the textbook "dangling else" bug: `if(a){if(b)x;}else y;` means
// "else belongs to a", but naively stripping both pairs of braces gives
// `if(a)if(b)x;else y;`, where `else` now binds to the *nearest* if
// (`b`) instead — a silent behaviour change, not a syntax error, so it
// would never show up as a compile failure.
//
// The functions below are a small recursive-descent statement scanner
// (`scan_statement`) plus a rewriter (`rewrite_body`/`rewrite_sequence`)
// that only strips a block's braces when doing so cannot change which
// `if` a later `else` binds to (`is_hungry`) and the block's single
// statement isn't a declaration (declarations are never valid as the
// brace-less body of if/for/while, even though expression statements,
// `return`, `break`, `continue` and `discard` all are).
// ---------------------------------------------------------------------

/// Consumes exactly one GLSL statement starting at `start` and returns
/// the index just past it, or `None` if what follows doesn't parse as
/// a single well-formed statement — used both to find statement
/// boundaries and (by returning `None` on constructs we don't model,
/// like `switch`) to make the whole pass decline gracefully rather
/// than guess on shapes it doesn't understand.
fn scan_statement(items: &[Item], start: usize) -> Option<usize> {
    match find_ident(items, start) {
        Some("if") => {
            let paren_end = skip_balanced(items, start + 1, '(', ')')?;
            let then_end = scan_statement(items, paren_end)?;
            if find_ident(items, then_end) == Some("else") {
                scan_statement(items, then_end + 1)
            } else {
                Some(then_end)
            }
        }
        Some("for") | Some("while") => {
            let paren_end = skip_balanced(items, start + 1, '(', ')')?;
            scan_statement(items, paren_end)
        }
        Some("do") => {
            let body_end = scan_statement(items, start + 1)?;
            if find_ident(items, body_end) != Some("while") {
                return None;
            }
            let paren_end = skip_balanced(items, body_end + 1, '(', ')')?;
            match items.get(paren_end).map(|it| &it.tok) {
                Some(Tok::Punct(';')) => Some(paren_end + 1),
                _ => None,
            }
        }
        _ => match items.get(start).map(|it| &it.tok) {
            Some(Tok::Punct('{')) => skip_balanced(items, start, '{', '}'),
            Some(Tok::Punct(';')) => Some(start + 1),
            None => None,
            _ => {
                // Expression statement, declaration, return/break/
                // continue/discard, or an empty `;` — all share the
                // same shape here: consume tokens (tracking paren/
                // bracket depth so a `;` inside e.g. a `for(...)`
                // header never counts) up to the next top-level `;`.
                // Hitting an unexpected `{`/`}` at depth 0 means this
                // is some construct we don't model (a `switch` body, an
                // interface block, ...) — bail rather than mis-scan it.
                let mut i = start;
                let mut depth = 0i32;
                loop {
                    match items.get(i).map(|it| &it.tok) {
                        None => return None,
                        Some(Tok::Punct('(')) | Some(Tok::Punct('[')) => depth += 1,
                        Some(Tok::Punct(')')) | Some(Tok::Punct(']')) => depth -= 1,
                        Some(Tok::Punct('{')) | Some(Tok::Punct('}')) => return None,
                        Some(Tok::Punct(';')) if depth == 0 => return Some(i + 1),
                        _ => {}
                    }
                    i += 1;
                }
            }
        },
    }
}

/// True if the statement at `start` still has an "open" (else-less)
/// `if` as its rightmost branch — i.e. a trailing `else` placed
/// immediately after this statement would bind to *that* inner `if`
/// rather than passing through to whatever encloses this statement.
/// A `{...}` block is never hungry (its braces already resolve any
/// ambiguity inside them); `for`/`while` propagate their body's
/// hunger (an else-less `if` as a bare loop body can still steal a
/// trailing `else`, same as it would with no loop wrapping it at all).
fn is_hungry(items: &[Item], start: usize) -> bool {
    match find_ident(items, start) {
        Some("if") => {
            let paren_end = match skip_balanced(items, start + 1, '(', ')') {
                Some(v) => v,
                None => return false,
            };
            let then_end = match scan_statement(items, paren_end) {
                Some(v) => v,
                None => return false,
            };
            if find_ident(items, then_end) == Some("else") {
                is_hungry(items, then_end + 1)
            } else {
                true
            }
        }
        Some("for") | Some("while") => match skip_balanced(items, start + 1, '(', ')') {
            Some(paren_end) => is_hungry(items, paren_end),
            None => false,
        },
        _ => false,
    }
}

/// A declaration (`float x=1.;`, `const int n=3;`, ...) is never valid
/// GLSL as the brace-less body of `if`/`for`/`while` — only a genuine
/// `statement` (expression, jump, block, nested control-flow, or empty
/// `;`) is. `type_keywords()` covers the ordinary case; `const` and the
/// precision qualifiers are checked separately since they're valid
/// declaration prefixes but aren't in that set (which only names types).
fn looks_like_declaration(items: &[Item], start: usize) -> bool {
    let type_kw = type_keywords();
    match (
        items.get(start).map(|it| &it.tok),
        items.get(start + 1).map(|it| &it.tok),
    ) {
        (Some(Tok::Ident(a)), Some(Tok::Ident(_))) => {
            type_kw.contains(a.as_str()) || matches!(a.as_str(), "const" | "highp" | "mediump" | "lowp")
        }
        _ => false,
    }
}

/// Rewrites the statement at a "body position" — the then-branch,
/// else-branch, or `for`/`while` body spanning `[body_start, body_end)`
/// — stripping its braces when it holds exactly one statement and doing
/// so is safe (see module docs). `has_trailing_else` is whether this
/// particular body is immediately followed by an `else` that could be
/// misattributed if the body turns out to be hungry once unwrapped.
fn rewrite_control_body(
    items: &[Item],
    body_start: usize,
    body_end: usize,
    has_trailing_else: bool,
    stats: &mut AggressiveStats,
) -> Option<Vec<Item>> {
    if matches!(items.get(body_start).map(|it| &it.tok), Some(Tok::Punct('{'))) {
        let inner_start = body_start + 1;
        let inner_end = body_end - 1; // body_end is just past the matching '}'
        let single = inner_start < inner_end && scan_statement(items, inner_start) == Some(inner_end);
        if single {
            let is_decl = looks_like_declaration(items, inner_start);
            let unsafe_hungry = has_trailing_else && is_hungry(items, inner_start);
            if !is_decl && !unsafe_hungry {
                stats.braces_removed += 1;
                let (toks, _) = rewrite_body(items, inner_start, stats)?;
                return Some(toks);
            }
        }
        // Multiple statements, or unsafe/declaration — keep these
        // braces, but still recurse into the contents: a nested
        // if/for/while further inside may still have its own
        // (independently safe) braces to strip.
        let mut out = vec![items[body_start].clone()];
        out.extend(rewrite_sequence(items, inner_start, inner_end, stats));
        out.push(items[inner_end].clone());
        Some(out)
    } else {
        // Already brace-less in the source — still recurse in case it's
        // itself a nested control statement with strippable braces.
        let (toks, _) = rewrite_body(items, body_start, stats)?;
        Some(toks)
    }
}

/// Rewrites exactly one statement starting at `start`, recursing into
/// if/for/while/do/block structure to strip nested redundant braces
/// wherever it's safe to. Returns the rewritten tokens plus the end
/// index in the *original* stream (so the caller can advance past it).
fn rewrite_body(items: &[Item], start: usize, stats: &mut AggressiveStats) -> Option<(Vec<Item>, usize)> {
    match find_ident(items, start) {
        Some("if") => {
            let mut out = vec![items[start].clone()];
            let paren_end = skip_balanced(items, start + 1, '(', ')')?;
            out.extend_from_slice(&items[start + 1..paren_end]);
            let then_end = scan_statement(items, paren_end)?;
            let has_else = find_ident(items, then_end) == Some("else");
            out.extend(rewrite_control_body(items, paren_end, then_end, has_else, stats)?);
            let mut i = then_end;
            if has_else {
                out.push(items[i].clone());
                let else_start = i + 1;
                let else_end = scan_statement(items, else_start)?;
                out.extend(rewrite_control_body(items, else_start, else_end, false, stats)?);
                i = else_end;
            }
            Some((out, i))
        }
        Some("for") | Some("while") => {
            let mut out = vec![items[start].clone()];
            let paren_end = skip_balanced(items, start + 1, '(', ')')?;
            out.extend_from_slice(&items[start + 1..paren_end]);
            let body_end = scan_statement(items, paren_end)?;
            out.extend(rewrite_control_body(items, paren_end, body_end, false, stats)?);
            Some((out, body_end))
        }
        Some("do") => {
            let mut out = vec![items[start].clone()];
            let body_end = scan_statement(items, start + 1)?;
            out.extend(rewrite_control_body(items, start + 1, body_end, false, stats)?);
            let mut i = body_end;
            if find_ident(items, i) != Some("while") {
                return None;
            }
            out.push(items[i].clone());
            let paren_end = skip_balanced(items, i + 1, '(', ')')?;
            out.extend_from_slice(&items[i + 1..paren_end]);
            i = paren_end;
            match items.get(i).map(|it| &it.tok) {
                Some(Tok::Punct(';')) => {
                    out.push(items[i].clone());
                    Some((out, i + 1))
                }
                _ => None,
            }
        }
        _ => match items.get(start).map(|it| &it.tok) {
            Some(Tok::Punct('{')) => {
                let close = skip_balanced(items, start, '{', '}')?;
                let mut out = vec![items[start].clone()];
                out.extend(rewrite_sequence(items, start + 1, close - 1, stats));
                out.push(items[close - 1].clone());
                Some((out, close))
            }
            _ => {
                let end = scan_statement(items, start)?;
                Some((items[start..end].to_vec(), end))
            }
        },
    }
}

/// Rewrites a sequence of statements spanning `[start, end)` (the
/// contents of a block), one statement at a time. If a statement can't
/// be parsed (an unmodelled construct like `switch`), copies the
/// remainder of the range through unchanged rather than risk mangling
/// something it doesn't understand — declining to golf is always safe,
/// guessing isn't.
fn rewrite_sequence(items: &[Item], start: usize, end: usize, stats: &mut AggressiveStats) -> Vec<Item> {
    let mut out = Vec::new();
    let mut i = start;
    while i < end {
        match rewrite_body(items, i, stats) {
            Some((toks, next)) if next > i && next <= end => {
                out.extend(toks);
                i = next;
            }
            _ => {
                out.extend_from_slice(&items[i..end]);
                break;
            }
        }
    }
    out
}

/// Entry point: finds each top-level `{...}` block in the token stream
/// (a function body, struct body, interface block, ...) and rewrites
/// its contents as a statement sequence. Everything outside any braces
/// (return types, function signatures, global declarations, `#define`/
/// `#version` lines) is copied through untouched — brace-stripping only
/// ever applies to statements *inside* a block.
pub fn strip_redundant_braces(items: Vec<Item>, stats: &mut AggressiveStats) -> Vec<Item> {
    let mut out = Vec::with_capacity(items.len());
    let mut i = 0;
    while i < items.len() {
        if matches!(items[i].tok, Tok::Punct('{')) {
            if let Some(close) = skip_balanced(&items, i, '{', '}') {
                out.push(items[i].clone());
                out.extend(rewrite_sequence(&items, i + 1, close - 1, stats));
                out.push(items[close - 1].clone());
                i = close;
                continue;
            }
        }
        out.push(items[i].clone());
        i += 1;
    }
    out
}
