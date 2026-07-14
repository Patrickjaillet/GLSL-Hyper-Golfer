use crate::aggressive::{
    compound_assignments, eliminate_dead_functions, eliminate_dead_locals, eliminate_dead_stores,
    fold_additive_constants, fold_additive_float_constants, fold_constants, fold_float_constants,
    increment_decrement, merge_declarations, reduce_constant_vectors, strip_duplicate_precision,
    strip_redundant_braces, strip_redundant_parens, strip_trailing_void_return, ternary_from_if_else,
    AggressiveStats, Item,
};
use crate::lexer::{tokenize_spaced, Tok};
use crate::vocab::{
    builtin_functions, builtin_variables, declaration_introducers, keywords, protected_host_names,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GolfStats {
    pub input_chars: usize,
    pub output_chars: usize,
    pub reduction_pct: f64,
    pub renamed_count: usize,
    pub numbers_shortened: usize,
    // Deliberately *not* `#[serde(flatten)]` — the web UI (and the
    // `GolfStats` TS interface it's typed against) expects these under
    // a nested `stats.aggressive.*`, not spliced into `stats` itself.
    pub aggressive: AggressiveStats,
}

#[derive(Serialize, Debug, Clone)]
pub struct GolfResult {
    pub code: String,
    pub stats: GolfStats,
}

/// Returns the shortest scientific-notation text (`1e6`, `1.23e-4`,
/// ...) that reparses to the exact same `f32` value as `value`, or
/// `None` if `value` is zero (scientific notation is never shorter for
/// zero) — used by `shorten_number` (ROADMAP.md Phase 1.1) to compare
/// against the plain decimal form and keep whichever is shorter.
/// Rust's `{value:e}` already produces the shortest round-tripping
/// decimal in scientific form (same guarantee as its plain `{value}`
/// Display), formatted exactly as GLSL's exponent syntax allows
/// (`digit-sequence exponent-part`, no decimal point required — see
/// the GLSL ES spec's `floating-constant` grammar): no explicit `+` on
/// a positive exponent, lowercase `e`. The round-trip check is a cheap
/// safety net, not expected to ever actually fail.
fn shortest_scientific_form(value: f32) -> Option<String> {
    if value == 0.0 {
        return None;
    }
    let text = format!("{value:e}");
    if text.parse::<f32>() != Ok(value) {
        return None;
    }
    Some(text)
}

/// Shortens a numeric literal's text without changing its value:
/// `0.5` -> `.5`, `2.0` -> `2.`, `3.100` -> `3.1`, `1.0e5` untouched in
/// the exponent (only the mantissa is normalised). For a literal that
/// doesn't already use an exponent, also compares the plain decimal
/// form against scientific notation (`1000000.` vs `1e6`,
/// `.0001` vs `1e-4`) and keeps whichever is shorter (ROADMAP.md Phase
/// 1.1) — re-deriving an optimal exponent for a literal that already
/// has one is left out of scope for this first version.
fn shorten_number(raw: &str) -> String {
    // Split off trailing type suffix (u/U/f/F) and exponent, if any.
    let mut mantissa = raw;
    let mut suffix = String::new();
    while let Some(last) = mantissa.chars().last() {
        if last == 'u' || last == 'U' || last == 'f' || last == 'F' {
            suffix.insert(0, last);
            mantissa = &mantissa[..mantissa.len() - 1];
        } else {
            break;
        }
    }
    let (mantissa, exponent) = match mantissa.find(['e', 'E']) {
        Some(idx) => (&mantissa[..idx], mantissa[idx..].to_string()),
        None => (mantissa, String::new()),
    };

    if mantissa.starts_with("0x") || mantissa.starts_with("0X") {
        return raw.to_string(); // never touch hex literals
    }

    let mut result = mantissa.to_string();
    if let Some(dot) = result.find('.') {
        let (int_part, frac_part) = result.split_at(dot);
        let frac_part = &frac_part[1..]; // drop the dot itself
        let trimmed_frac = frac_part.trim_end_matches('0');
        let int_part = if int_part == "0" { "" } else { int_part };
        if int_part.is_empty() && trimmed_frac.is_empty() {
            // "0.0" etc: a bare "." has no digit at all and is not a
            // valid GLSL float literal, so keep exactly one digit.
            result = "0.".to_string();
        } else {
            result = format!("{int_part}.{trimmed_frac}");
        }
    }

    // Only for literals that are *already* float-typed (contain a `.`)
    // — a bare integer like `1000000` must never become `1e6`: that
    // would silently change its GLSL type from `int` to `float`
    // (breaking e.g. an array size or a loop counter that requires an
    // int), even though the numeric value is unchanged.
    if exponent.is_empty() && mantissa.contains('.') {
        if let Ok(value) = mantissa.parse::<f32>() {
            if let Some(sci) = shortest_scientific_form(value) {
                if sci.len() < result.len() {
                    result = sci;
                }
            }
        }
    }

    format!("{result}{exponent}{suffix}")
}

/// Generates an infinite stream of candidate short identifiers:
/// a, b, c, ... z, aa, ab, ... skipping anything that collides with a
/// reserved word.
struct NameGen {
    len: usize,
    counter: usize,
}
impl NameGen {
    fn new() -> Self {
        Self { len: 1, counter: 0 }
    }
}
impl Iterator for NameGen {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_";
        let base = ALPHABET.len();
        let total_for_len: usize = (0..self.len).fold(1, |acc, _| acc * base);
        if self.counter >= total_for_len {
            self.len += 1;
            self.counter = 0;
        }
        let mut n = self.counter;
        let mut chars = Vec::with_capacity(self.len);
        for _ in 0..self.len {
            chars.push(ALPHABET[n % base] as char);
            n /= base;
        }
        chars.reverse();
        self.counter += 1;
        Some(chars.into_iter().collect())
    }
}

/// Returns the token-index span `(open, close)` of every `struct { ... }`
/// body (indices of the braces themselves) in the token stream.
///
/// Needed because a struct's *members* are declared with the exact same
/// `<type> <ident>` shape as an ordinary local/global (`struct P{float
/// x;float y;};`) — but a member name isn't a bare identifier anywhere
/// else in the file the way a real variable is; it only ever appears
/// after a `.`, alongside every *other* use of that name as a swizzle
/// component (`somevec.x`) or an unrelated variable. Blanket-renaming
/// it would rename those too. See `find_renamable`, which uses this to
/// exclude member declarations from the renamable pool entirely rather
/// than attempt (much harder, and not attempted here) type-aware
/// tracking of which `.field` belongs to which struct.
fn struct_body_ranges(tokens: &[Tok]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let is_struct_kw = matches!(&tokens[i], Tok::Ident(s) if s == "struct");
        if is_struct_kw {
            let mut j = i + 1;
            while j < tokens.len() && !matches!(tokens[j], Tok::Punct('{') | Tok::Punct(';')) {
                j += 1;
            }
            if matches!(tokens.get(j), Some(Tok::Punct('{'))) {
                let mut depth = 0i32;
                let mut k = j;
                loop {
                    match tokens.get(k) {
                        Some(Tok::Punct('{')) => depth += 1,
                        Some(Tok::Punct('}')) => {
                            depth -= 1;
                            if depth == 0 {
                                ranges.push((j, k));
                                break;
                            }
                        }
                        None => break,
                        _ => {}
                    }
                    k += 1;
                }
                i = k;
                continue;
            }
        }
        i += 1;
    }
    ranges
}

fn strictly_inside_any(idx: usize, ranges: &[(usize, usize)]) -> bool {
    ranges.iter().any(|(open, close)| idx > *open && idx < *close)
}

/// Returns the token-index span `(open, close)` of every top-level
/// `{...}` block — struct bodies, function bodies, interface blocks,
/// found by scanning for a `{` at brace-depth 0 and jumping straight to
/// its match (so anything nested inside is never independently visited
/// as "top-level" by this scan).
fn top_level_brace_ranges(tokens: &[Tok]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        if matches!(tokens[i], Tok::Punct('{')) {
            let mut depth = 0i32;
            let mut k = i;
            loop {
                match tokens.get(k) {
                    Some(Tok::Punct('{')) => depth += 1,
                    Some(Tok::Punct('}')) => {
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
            if k < tokens.len() {
                ranges.push((i, k));
                i = k + 1;
                continue;
            }
        }
        i += 1;
    }
    ranges
}

/// If `body_open` is a function body's opening `{` (i.e. the token right
/// before it closes a parameter list), returns the index of that
/// parameter list's own `(` — so the returned range covers parameters
/// too, not just the body. Function parameters are only visible inside
/// their own function, exactly like locals, and must be treated as such
/// for scope-aware renaming; returns `body_open` unchanged if there's no
/// parameter list immediately before it (e.g. a bare top-level block).
fn extend_left_to_params(tokens: &[Tok], body_open: usize) -> usize {
    if body_open == 0 || !matches!(tokens[body_open - 1], Tok::Punct(')')) {
        return body_open;
    }
    let mut depth = 0i32;
    let mut k = body_open - 1;
    loop {
        match &tokens[k] {
            Tok::Punct(')') => depth += 1,
            Tok::Punct('(') => {
                depth -= 1;
                if depth == 0 {
                    return k;
                }
            }
            _ => {}
        }
        if k == 0 {
            break;
        }
        k -= 1;
    }
    body_open
}

/// The token-index span of every function body in the file (parameters
/// through the closing brace), used to scope-partition renaming: two
/// locals in two *different* function scopes never conflict, and can
/// safely be handed the same short name — see `find_renamable` and
/// `golf()`. Struct bodies are excluded (their "members" are handled
/// separately, see `struct_body_ranges`); everything else at the top
/// level is assumed to be a function (the only other top-level brace
/// construct GLSL has — interface/uniform blocks — isn't used by this
/// app's shaders, and would just be harmlessly treated as a "function"
/// with no params here if it appeared).
fn function_scope_ranges(tokens: &[Tok]) -> Vec<(usize, usize)> {
    let struct_bodies = struct_body_ranges(tokens);
    top_level_brace_ranges(tokens)
        .into_iter()
        .filter(|(open, _)| !struct_bodies.iter().any(|(s, _)| s == open))
        .map(|(open, close)| (extend_left_to_params(tokens, open), close))
        .collect()
}

/// Which independently-renamable scope a declaration belongs to.
/// `Local(i)` is only visible within `function_scope_ranges(tokens)[i]`;
/// `Global` is visible everywhere (true globals, struct/function names,
/// and — conservatively — any name whose declaration pattern matches in
/// more than one place, since this pass doesn't track *which* of
/// several same-named declarations a given use refers to).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Scope {
    Global,
    Local(usize),
}

/// Extracts every identifier-shaped substring (`[A-Za-z_][A-Za-z0-9_]*`)
/// from a raw text fragment, without tokenizing it as GLSL.
fn identifiers_in_text(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.insert(chars[start..i].iter().collect());
        } else {
            i += 1;
        }
    }
    out
}

/// Every identifier-shaped word appearing on any `#`-directive line.
///
/// `#define` bodies are kept as opaque, never-tokenized text (see
/// `lexer.rs`) — so if a name referenced only inside a macro body
/// (`#define GET_X(p) (p.x + OFFSET)`) is *also* declared as an
/// ordinary variable elsewhere (`float OFFSET = 1.0;`), renaming that
/// declaration desyncs it from the macro: the preprocessor still
/// expands `OFFSET` verbatim, now referencing a name that no longer
/// exists anywhere. `find_renamable` uses this to exclude any such name
/// from the renamable pool entirely, the same way struct member names
/// are excluded — declining to rename is always safe, guessing at
/// which macro references matter isn't. (This also protects names used
/// in `#ifdef`/`#if`/etc, which don't actually need it — `#ifdef` only
/// tests macro-definedness, unrelated to variables of the same
/// spelling — but there's no harm in the extra caution.)
fn preproc_referenced_names(tokens: &[Tok]) -> HashSet<String> {
    let mut out = HashSet::new();
    for tok in tokens {
        if let Tok::Preproc(line) = tok {
            out.extend(identifiers_in_text(line));
        }
    }
    out
}

/// Scans the token stream for `<type> <ident>` declaration patterns
/// (covers globals, locals, function params after their type, function
/// names, and `for (int i ...)` loop counters) and returns identifiers
/// that are safe and beneficial to rename, each tagged with the scope
/// it's declared in and ranked by usage frequency (frequency drives
/// assignment order across *all* scopes together, so a hot local still
/// gets a shorter name than a rarely-used global — only the pool of
/// short names each one draws from is scope-partitioned; see `golf()`).
/// Struct member declarations are deliberately excluded (see
/// `struct_body_ranges`) — the struct's own type name, declared just
/// before the `{`, is unaffected and still gets renamed normally.
fn find_renamable(tokens: &[Tok]) -> Vec<(String, Scope)> {
    let kw = keywords();
    let declaration_kw = declaration_introducers();
    let builtins = builtin_functions();
    let builtin_vars = builtin_variables();
    let protected = protected_host_names();
    let struct_bodies = struct_body_ranges(tokens);
    let preproc_names = preproc_referenced_names(tokens);
    let function_scopes = function_scope_ranges(tokens);

    let mut freq: HashMap<String, usize> = HashMap::new();
    let mut first_seen: HashMap<String, usize> = HashMap::new();
    // Every scope a name's declaration pattern matched in. More than one
    // distinct scope (or a global alongside any local) means we can't
    // tell which use belongs to which declaration site, so it's treated
    // as Global — the always-safe fallback. See `Scope`.
    let mut scopes_seen: HashMap<String, HashSet<Option<usize>>> = HashMap::new();

    for (idx, tok) in tokens.iter().enumerate() {
        if let Tok::Ident(name) = tok {
            *freq.entry(name.clone()).or_insert(0) += 1;
            first_seen.entry(name.clone()).or_insert(idx);
        }
    }

    for i in 0..tokens.len().saturating_sub(1) {
        if let (Tok::Ident(a), Tok::Ident(b)) = (&tokens[i], &tokens[i + 1]) {
            let a_is_type = declaration_kw.contains(a.as_str());
            let b_is_user = !kw.contains(b.as_str())
                && !builtins.contains(b.as_str())
                && !builtin_vars.contains(b.as_str())
                && !protected.contains(b.as_str());
            if a_is_type
                && b_is_user
                && !strictly_inside_any(i + 1, &struct_bodies)
                && !preproc_names.contains(b.as_str())
            {
                let fn_idx = function_scopes
                    .iter()
                    .position(|(s, e)| i + 1 > *s && i + 1 < *e);
                scopes_seen.entry(b.clone()).or_default().insert(fn_idx);
            }
        }
    }

    let mut list: Vec<(String, Scope)> = scopes_seen
        .into_iter()
        .map(|(name, tags)| {
            let scope = match tags.into_iter().collect::<Vec<_>>().as_slice() {
                [Some(idx)] => Scope::Local(*idx),
                _ => Scope::Global,
            };
            (name, scope)
        })
        .collect();
    // Most-frequently used identifiers get the shortest names, across
    // every scope together.
    list.sort_by(|(a, _), (b, _)| {
        let fa = freq.get(a).copied().unwrap_or(0);
        let fb = freq.get(b).copied().unwrap_or(0);
        fb.cmp(&fa)
            .then_with(|| first_seen.get(a).cmp(&first_seen.get(b)))
    });
    list
}

/// Which of the optional "Golf agressif" structural passes to run —
/// lets the UI offer one checkbox per pass instead of a single
/// all-or-nothing toggle, so a user can keep the passes that helped and
/// individually turn off whichever one broke their particular shader.
/// See `aggressive.rs` for what each pass does and does not touch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AggressiveOptions {
    pub eliminate_dead_locals: bool,
    pub eliminate_dead_stores: bool,
    pub fold_constants: bool,
    pub reduce_constant_vectors: bool,
    pub strip_trailing_void_return: bool,
    pub compound_assignments: bool,
    pub increment_decrement: bool,
    pub ternary_from_if_else: bool,
    pub merge_declarations: bool,
    pub strip_redundant_braces: bool,
    pub strip_redundant_parens: bool,
    pub strip_duplicate_precision: bool,
    pub eliminate_dead_functions: bool,
}

impl AggressiveOptions {
    pub fn all() -> Self {
        Self {
            eliminate_dead_locals: true,
            eliminate_dead_stores: true,
            fold_constants: true,
            reduce_constant_vectors: true,
            strip_trailing_void_return: true,
            compound_assignments: true,
            increment_decrement: true,
            ternary_from_if_else: true,
            merge_declarations: true,
            strip_redundant_braces: true,
            strip_redundant_parens: true,
            strip_duplicate_precision: true,
            eliminate_dead_functions: true,
        }
    }

    pub fn none() -> Self {
        Self {
            eliminate_dead_locals: false,
            eliminate_dead_stores: false,
            fold_constants: false,
            reduce_constant_vectors: false,
            strip_trailing_void_return: false,
            compound_assignments: false,
            increment_decrement: false,
            ternary_from_if_else: false,
            merge_declarations: false,
            strip_redundant_braces: false,
            strip_redundant_parens: false,
            strip_duplicate_precision: false,
            eliminate_dead_functions: false,
        }
    }
}

/// Runs the full golf pipeline: rename → shorten numbers → tight
/// layout, then whichever `aggressive` structural passes are turned on
/// (`AggressiveOptions::all()`/`::none()` for the common all-or-nothing
/// cases — see `golf()`, the simpler boolean-flag entry point most
/// callers want). Equivalent to `golf_with_protected_names` with an
/// empty protected-names list.
pub fn golf_with_options(source: &str, aggressive: AggressiveOptions) -> GolfResult {
    golf_with_protected_names(source, aggressive, &[])
}

/// Same as `golf_with_options`, plus a caller-supplied list of
/// identifiers that must never be renamed — e.g. a custom uniform a
/// host application binds by name, which isn't one of the fixed
/// Shadertoy uniforms already in `protected_host_names` and would
/// otherwise be renamed like any other identifier, silently breaking
/// that binding. A name here is filtered out of `renamable` right
/// away, which handles both halves of "never rename this" for free:
/// it's excluded from the rename-assignment loop below, *and* the
/// existing "protect every identifier the source already uses" sweep
/// (a few lines down) automatically adds its spelling to `taken` once
/// it's no longer present in `renamable_set` — no separate code path
/// needed for that second half.
pub fn golf_with_protected_names(
    source: &str,
    aggressive: AggressiveOptions,
    protected_names: &[String],
) -> GolfResult {
    let input_chars = source.chars().count();
    let spaced = tokenize_spaced(source);
    let tokens: Vec<Tok> = spaced.iter().map(|(t, _)| t.clone()).collect();
    let had_space: Vec<bool> = spaced.iter().map(|(_, s)| *s).collect();

    let kw = keywords();
    let builtins = builtin_functions();
    let builtin_vars = builtin_variables();
    let protected = protected_host_names();

    let protected_names_set: HashSet<&str> = protected_names.iter().map(|s| s.as_str()).collect();
    let renamable: Vec<(String, Scope)> = find_renamable(&tokens)
        .into_iter()
        .filter(|(name, _)| !protected_names_set.contains(name.as_str()))
        .collect();

    let mut taken: HashSet<String> = HashSet::new();
    taken.extend(kw.iter().map(|s| s.to_string()));
    taken.extend(builtins.iter().map(|s| s.to_string()));
    taken.extend(builtin_vars.iter().map(|s| s.to_string()));
    taken.extend(protected.iter().map(|s| s.to_string()));
    // Also protect every identifier that appears in the source but
    // *isn't* being renamed (struct instance names whose type wasn't
    // recognized, struct member names excluded by find_renamable,
    // anything our declaration heuristic simply doesn't catch). Without
    // this, a freshly chosen short name can collide with one of these
    // untouched originals — e.g. an unrenamed `Foo f;` instance
    // colliding with some *other* variable that the renamer picks "f"
    // for, producing two different variables declared under the same
    // name in the same scope. Kept as a single *global* exclusion
    // (rather than scoped to wherever the untouched name is actually
    // used) — more conservative than strictly necessary, but simple and
    // always safe.
    let renamable_set: HashSet<&str> = renamable.iter().map(|(name, _)| name.as_str()).collect();
    for tok in &tokens {
        if let Tok::Ident(name) = tok {
            if !renamable_set.contains(name.as_str()) {
                taken.insert(name.clone());
            }
        }
    }
    // Also protect every name referenced *only* inside a `#define` body
    // (e.g. `PI` in `#define TAU (2.0*PI)` when `PI` never appears as a
    // bare token anywhere else) — `#define` lines are kept verbatim and
    // never tokenized past their raw text (see `Tok::Preproc`), so a
    // name like this is otherwise entirely invisible to the sweep just
    // above, even though the real GLSL preprocessor will substitute it
    // textually wherever it's spelled after its point of definition.
    // Without this, NameGen could hand out that exact spelling to some
    // unrelated variable, and the macro expansion would then silently
    // reference the freshly-renamed variable instead of what the source
    // actually meant — or outright fail to compile if the generated
    // name collides with the macro's own declaration line. This was a
    // real gap: `preproc_referenced_names` already existed and was used
    // by `find_renamable` to stop a same-named *declaration* from being
    // renamed, but that's only half of what's needed — the other half,
    // protecting the spelling from being *generated* as a new name, was
    // missing until now.
    taken.extend(preproc_referenced_names(&tokens));

    // Scope-aware assignment: `taken` holds names visible *everywhere*
    // (keywords/builtins/protected/untouched-originals plus every
    // already-assigned Global name), while `local_taken[i]` holds names
    // already claimed within function scope `i` alone. Two locals in
    // *different* function scopes never conflict — `for(int i...)` in
    // one function and `for(int i...)` in a completely unrelated one
    // can both become `for(int a...)` — so each scope gets its own
    // fresh a,b,c... search rather than sharing one ever-growing
    // sequence across the whole file. Declarations are still assigned
    // in frequency order across *all* scopes together (that ordering
    // comes from `find_renamable`), so a hot local still outranks a
    // rarely-used global for the shortest names — only the pool of
    // candidates each one draws from is scope-partitioned.
    let mut local_taken: HashMap<usize, HashSet<String>> = HashMap::new();
    let mut rename_map: HashMap<String, String> = HashMap::new();
    for (original, scope) in &renamable {
        let mut gen = NameGen::new();
        loop {
            let candidate = gen.next().unwrap();
            // A Global name is visible from *inside* every function too
            // (including, notably, a function's own name being visible
            // within its own body — e.g. for recursion), so assigning
            // one must avoid every scope's local names, not just other
            // globals. A Local name only needs to avoid globals and its
            // own function's other locals — a *different* function's
            // locals are never visible here, which is exactly the reuse
            // this scope-partitioning is for.
            let collides = taken.contains(&candidate)
                || match scope {
                    Scope::Local(idx) => local_taken
                        .get(idx)
                        .is_some_and(|s| s.contains(&candidate)),
                    Scope::Global => local_taken.values().any(|s| s.contains(&candidate)),
                };
            if collides {
                continue;
            }
            match scope {
                Scope::Global => {
                    taken.insert(candidate.clone());
                }
                Scope::Local(idx) => {
                    local_taken.entry(*idx).or_default().insert(candidate.clone());
                }
            }
            rename_map.insert(original.clone(), candidate);
            break;
        }
    }

    let mut numbers_shortened = 0usize;
    let mut items: Vec<Item> = Vec::with_capacity(tokens.len());

    for (idx, tok) in tokens.iter().enumerate() {
        // A `.` immediately before an identifier makes it a field/swizzle
        // selector (`p.x`, `foo.bar`), never a variable reference — the
        // tokenizer can't tell `x` used as a name from `x` used as a
        // swizzle component, so without this guard renaming an unrelated
        // variable named `x` anywhere in the file (e.g. a function
        // parameter) would also rewrite every `.x` swizzle in the file,
        // producing an illegal field selector. Left untouched here.
        let preceded_by_dot = idx > 0 && matches!(tokens[idx - 1], Tok::Punct('.'));
        let text = match tok {
            Tok::Ident(name) if preceded_by_dot => name.clone(),
            Tok::Ident(name) => rename_map.get(name).cloned().unwrap_or_else(|| name.clone()),
            Tok::Number(raw) => {
                let shortened = shorten_number(raw);
                if shortened != *raw {
                    numbers_shortened += 1;
                }
                shortened
            }
            Tok::Punct(c) => c.to_string(),
            Tok::Preproc(_) => String::new(),
        };
        items.push(Item {
            tok: tok.clone(),
            text,
            space_before: had_space[idx],
        });
    }

    // Run the whole aggressive pipeline to a fixpoint rather than once
    // through in a fixed order (ROADMAP.md Phase 0): a pass earlier in
    // the list can only ever benefit from one later in the list within
    // a single pass-through, never the other way round (e.g. stripping
    // braces can leave two writes newly adjacent for
    // `eliminate_dead_stores`, which already ran). Re-running the whole
    // block until nothing changes catches those cascades for free, no
    // new golfing logic needed. `AggressiveStats` fields are simple
    // counters, so accumulating them across iterations (rather than
    // resetting each round) already gives the right "total across the
    // whole run" semantics. Hard iteration cap purely as a belt-and-
    // braces guard against an unforeseen oscillation between two passes
    // (none is known to exist; every pass is individually
    // size-non-increasing) rather than looping forever.
    const MAX_FIXPOINT_ITERATIONS: usize = 10;
    let mut aggressive_stats = AggressiveStats::default();
    for _ in 0..MAX_FIXPOINT_ITERATIONS {
        let before = items.clone();
        if aggressive.eliminate_dead_locals {
            items = eliminate_dead_locals(items, &mut aggressive_stats);
        }
        if aggressive.eliminate_dead_stores {
            items = eliminate_dead_stores(items, &mut aggressive_stats);
        }
        if aggressive.eliminate_dead_functions {
            items = eliminate_dead_functions(items, &mut aggressive_stats);
        }
        if aggressive.fold_constants {
            items = fold_constants(items, &mut aggressive_stats);
            // Same toggle, not a separate one: `+`/`-` folding is still
            // conceptually "constant folding", just a stricter pass than
            // the `*`/`/`/`%` one above (ROADMAP.md Phase 1.1) — no new
            // UI checkbox/CLI flag needed for what's really the same
            // feature getting wider coverage.
            items = fold_additive_constants(items, &mut aggressive_stats);
            // Same toggle again: float folding (`+`/`-`/`*`, ROADMAP.md
            // Phase 1.1) is scoped much more narrowly than int folding
            // (no `/`, no exponents/suffixes) but is still the same
            // feature conceptually — see `aggressive.rs`'s float-folding
            // section comment for the precision argument that makes it
            // safe.
            items = fold_float_constants(items, &mut aggressive_stats);
            items = fold_additive_float_constants(items, &mut aggressive_stats);
        }
        if aggressive.reduce_constant_vectors {
            items = reduce_constant_vectors(items, &mut aggressive_stats);
        }
        if aggressive.compound_assignments {
            items = compound_assignments(items, &mut aggressive_stats);
        }
        if aggressive.increment_decrement {
            items = increment_decrement(items, &mut aggressive_stats);
        }
        if aggressive.ternary_from_if_else {
            items = ternary_from_if_else(items, &mut aggressive_stats);
        }
        if aggressive.merge_declarations {
            items = merge_declarations(items, &mut aggressive_stats);
        }
        if aggressive.strip_redundant_braces {
            items = strip_redundant_braces(items, &mut aggressive_stats);
        }
        if aggressive.strip_redundant_parens {
            items = strip_redundant_parens(items, &mut aggressive_stats);
        }
        if aggressive.strip_duplicate_precision {
            items = strip_duplicate_precision(items, &mut aggressive_stats);
        }
        if aggressive.strip_trailing_void_return {
            items = strip_trailing_void_return(items, &mut aggressive_stats);
        }
        if items == before {
            break;
        }
    }

    let code = layout(&items);

    let output_chars = code.chars().count();
    let reduction_pct = if input_chars == 0 {
        0.0
    } else {
        (input_chars as f64 - output_chars as f64) / input_chars as f64 * 100.0
    };

    GolfResult {
        code,
        stats: GolfStats {
            input_chars,
            output_chars,
            reduction_pct,
            renamed_count: rename_map.len(),
            numbers_shortened,
            aggressive: aggressive_stats,
        },
    }
}

/// Simple boolean entry point most callers want: `true` runs every
/// aggressive pass, `false` runs none — see `golf_with_options` for
/// per-pass control (used by the UI's individual checkboxes).
pub fn golf(source: &str, aggressive: bool) -> GolfResult {
    golf_with_options(
        source,
        if aggressive {
            AggressiveOptions::all()
        } else {
            AggressiveOptions::none()
        },
    )
}

/// A token needs a separating space from its neighbour if both sides
/// are "word-like" (identifier or numeric-literal text) — GLSL always
/// required whitespace there in the first place, since two adjacent
/// alnum runs would otherwise lex as one token. Treating `.` as
/// punctuation (not word-like) is what keeps swizzles like `p.xz`
/// tight instead of becoming `p. xz`.
fn is_word_like(t: &Tok) -> bool {
    matches!(t, Tok::Ident(_) | Tok::Number(_))
}

/// Two-character GLSL operators that must never appear *by accident*:
/// if the previous emitted character plus the next token's first
/// character spell one of these, and the source had whitespace
/// between them, minification must keep at least one space or the
/// program's meaning changes (classic case: `x - -y` must not become
/// `x--y`).
const AMBIGUOUS_PAIRS: &[&str] = &[
    "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=", "*=", "/=", "%=",
    "&=", "|=", "^=", "//", "/*",
];

fn forms_ambiguous_pair(prev_char: char, next_char: char) -> bool {
    let mut s = String::with_capacity(2);
    s.push(prev_char);
    s.push(next_char);
    AMBIGUOUS_PAIRS.contains(&s.as_str())
}

/// Joins tokens back into a single string, inserting the minimum
/// whitespace needed so that no two tokens accidentally fuse into a
/// *different* token than the source intended (identifiers/numbers
/// running together, or two punctuation characters spelling an
/// operator that wasn't actually there, like `- -` collapsing to `--`).
fn layout(items: &[Item]) -> String {
    // Upper bound: every token's text (a `#`-directive's own line for
    // Preproc tokens, since those are emitted verbatim rather than via
    // `.text` — see the branch below), plus one separating space/newline
    // per token in the worst case (layout only ever *adds* a single
    // character of whitespace between two tokens, never more) — so the
    // real output length never exceeds this, and `out` never has to
    // reallocate while filling it.
    let capacity: usize = items
        .iter()
        .map(|it| match &it.tok {
            Tok::Preproc(line) => line.len() + 2,
            _ => it.text.len() + 1,
        })
        .sum();
    let mut out = String::with_capacity(capacity);
    let mut prev_word_like = false;

    for (i, item) in items.iter().enumerate() {
        if let Tok::Preproc(line) = &item.tok {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(line);
            out.push('\n');
            prev_word_like = false;
            continue;
        }

        let cur_word_like = is_word_like(&item.tok);
        let mut need_space = prev_word_like && cur_word_like;

        if !need_space && i > 0 && !out.is_empty()
            && matches!(&items[i - 1].tok, Tok::Punct(_)) && matches!(&item.tok, Tok::Punct(_)) {
                let prev_char = out.chars().last().unwrap();
                let next_char = item.text.chars().next().unwrap_or(' ');
                if item.space_before && forms_ambiguous_pair(prev_char, next_char) {
                    need_space = true;
                }
            }

        if need_space {
            out.push(' ');
        }
        out.push_str(&item.text);
        prev_word_like = cur_word_like;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::golf;
    use super::golf_with_protected_names;
    use super::AggressiveOptions;

    #[test]
    fn safe_mode_unchanged_by_default() {
        // "a" is used 3x (declarator + two reads) vs "f" used once, so
        // the frequency-ranked renamer gives "a" the shortest name it
        // already has and renames "f" instead — this pins that existing
        // safe-mode behaviour so the aggressive-mode tests below (which
        // build on top of it) don't silently drift. Also doubles as a
        // scope-aware-renaming regression test: a function's own name
        // is visible *inside* its own body (e.g. for recursion), so
        // its local "a" must never end up sharing "f"'s assigned short
        // name — a real bug caught by this exact test while
        // implementing scope-aware renaming (see `golf()`'s comment on
        // why Global candidates must check every scope's locals too).
        let r = golf("void f(){float a=1.0;a=a-1.0;}", false);
        assert_eq!(r.code, "void b(){float a=1.;a=a-1.;}");
        assert_eq!(r.stats.aggressive.compound_assignments, 0);
        assert_eq!(r.stats.aggressive.declarations_merged, 0);
    }

    #[test]
    fn swizzle_after_dot_is_never_treated_as_a_variable_reference() {
        // Regression: a function parameter named `x` gets renamed, but
        // the tokenizer can't distinguish that `Ident("x")` from the
        // `Ident("x")` in `p.x` (swizzle selector) elsewhere in the
        // file — both are the exact same token kind/text. Before the
        // `preceded_by_dot` guard in the token->Item substitution loop,
        // renaming the parameter also silently rewrote every unrelated
        // `.x`/`.y`/`.z` swizzle in the file, producing GLSL that fails
        // to compile with "illegal vector field selection".
        let r = golf("float h(float x){return x;}vec3 g(vec3 p){return vec3(p.x,p.y,p.z);}", false);
        assert!(r.code.contains(".x"), "swizzle .x must survive renaming: {}", r.code);
        assert!(r.code.contains(".y"), "swizzle .y must survive renaming: {}", r.code);
        assert!(r.code.contains(".z"), "swizzle .z must survive renaming: {}", r.code);
    }

    #[test]
    fn compound_assignment_single_term_rhs() {
        // "x-1.0" folds to "x-=1." (compound_assignments), which then
        // itself gets picked up by increment_decrement (RHS is exactly
        // "1.") and rewritten to the even shorter "--x;" — proof the two
        // passes compose as intended, not just each in isolation.
        let r = golf("x=x-1.0;", true);
        assert_eq!(r.code, "--x;");
        assert_eq!(r.stats.aggressive.compound_assignments, 1);
        assert_eq!(r.stats.aggressive.increments_decrements, 1);
    }

    #[test]
    fn increment_decrement_rewrites_compound_assign_by_one() {
        let r = golf("x+=1.0;y-=1.0;", true);
        assert_eq!(r.code, "++x;--y;");
        assert_eq!(r.stats.aggressive.increments_decrements, 2);
    }

    #[test]
    fn increment_decrement_refuses_amounts_other_than_one() {
        let r = golf("x+=2.0;", true);
        assert_eq!(r.code, "x+=2.;");
        assert_eq!(r.stats.aggressive.increments_decrements, 0);
    }

    #[test]
    fn increment_decrement_uses_prefix_so_expression_value_stays_correct() {
        // `a += 1` as a sub-expression evaluates to the *new* value of
        // `a` -- prefix `++a` matches that; postfix `a++` would not, so
        // this pins that the rewrite is prefix, not postfix, even
        // though both are the same length. The surrounding parens are
        // also stripped: after the rewrite, `(++x)` wraps a single
        // primary (a prefix unary op plus one identifier), which
        // `strip_redundant_parens` correctly recognizes as redundant.
        let r = golf("y=(x+=1.0);", true);
        assert_eq!(r.code, "y=++x;");
        assert_eq!(r.stats.aggressive.increments_decrements, 1);
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 1);
    }

    #[test]
    fn increment_decrement_never_collides_with_a_preceding_operator() {
        // Regression guard for a trap considered while adding this pass:
        // emitting a synthetic "++"/"--" right after another "+"/"-"
        // with no separator would risk real GLSL compilers re-lexing
        // three-in-a-row as e.g. "++"+"+" (maximal munch) instead of
        // "+"+"++" -- a classic C-family gotcha. It can't actually
        // happen here: `x+=1` only ever matches when `x` is a bare
        // lvalue (GLSL grammar requires it), so the token immediately
        // before `x` can never itself be a bare `+`/`-` with no
        // separator -- that would make `x` part of a non-lvalue
        // expression, which wouldn't have compiled as `+=`'s target in
        // the first place. Chained assignment (the one case where
        // another operator, `=`, does sit directly before the rewrite)
        // is exercised here to confirm no space corruption either way.
        let r = golf("y=x+=1.0;", true);
        assert_eq!(r.code, "y=++x;");
        assert_eq!(r.stats.aggressive.increments_decrements, 1);
    }

    #[test]
    fn ternary_from_braced_if_else() {
        let r = golf("void f(){if(x>0.){a=1.;}else{a=-1.;}}", true);
        assert_eq!(r.code, "void b(){a=(x>0.)?1.:-1.;}");
        assert_eq!(r.stats.aggressive.ternaries_from_if_else, 1);
    }

    #[test]
    fn ternary_from_unbraced_if_else() {
        let r = golf("float f(float ready,float xv,float yv){float a=0.;if(ready>0.)a=xv;else a=yv;return a;}", true);
        assert_eq!(r.stats.aggressive.ternaries_from_if_else, 1);
        assert!(!r.code.contains("if("), "if/else should have been fully collapsed: {}", r.code);
        assert!(r.code.contains("?") && r.code.contains(":"), "expected a ternary: {}", r.code);
    }

    #[test]
    fn ternary_refuses_mismatched_targets() {
        let r = golf("void f(){if(c){a=1.;}else{b=2.;}}", true);
        assert!(r.code.contains("if("), "must not rewrite when the two branches assign different variables: {}", r.code);
        assert_eq!(r.stats.aggressive.ternaries_from_if_else, 0);
    }

    #[test]
    fn ternary_refuses_multi_term_rhs() {
        // `a = p + q` is not a single scan_primary term, so folding it
        // into the ternary's arm is declined (same restriction
        // compound_assignments places on its right-hand side).
        let r = golf("void f(){if(c){a=p+q;}else{a=r;}}", true);
        assert!(r.code.contains("if("), "must not rewrite a multi-term arm: {}", r.code);
        assert_eq!(r.stats.aggressive.ternaries_from_if_else, 0);
    }

    #[test]
    fn ternary_wraps_condition_containing_its_own_ternary() {
        // If COND itself contains a top-level `?:` and were spliced in
        // unparenthesized, the new `?:` being added would silently
        // reassociate with it (`?:` is right-associative: `a?b:c?x:y`
        // parses as `a?b:(c?x:y)`, not the intended `(a?b:c)?x:y`).
        // Pinning that COND is always wrapped in a fresh `(...)`.
        let r = golf("void f(){if(c?d:e){a=1.;}else{a=2.;}}", true);
        assert_eq!(r.code, "void b(){a=(c?d:e)?1.:2.;}");
    }

    #[test]
    fn ternary_does_not_confuse_equality_with_assignment() {
        // The arm bodies are themselves comparisons (`a==1.;`), not
        // assignments to `a` -- must not be mistaken for the `a=X;`
        // shape this pass looks for.
        let r = golf("void f(){if(c){a==1.;}else{a==2.;}}", true);
        assert!(r.code.contains("if("), "must not treat == as an assignment: {}", r.code);
        assert_eq!(r.stats.aggressive.ternaries_from_if_else, 0);
    }

    #[test]
    fn compound_assignment_refuses_unsafe_chain() {
        // a -= (b - c) != a - b - c, so a longer +/- chain on the RHS
        // must never be folded into a compound assignment.
        let r = golf("x=x-y-z;", true);
        assert_eq!(r.code, "x=x-y-z;");
        assert_eq!(r.stats.aggressive.compound_assignments, 0);
    }

    #[test]
    fn compound_assignment_refuses_self_initializing_declarator() {
        // `float a+=1.;` is not valid GLSL syntax at a declarator.
        let r = golf("float a=a+1.0;", true);
        assert_eq!(r.code, "float a=a+1.;");
        assert_eq!(r.stats.aggressive.compound_assignments, 0);
    }

    #[test]
    fn compound_assignment_allows_parenthesised_single_term() {
        let r = golf("x=x/(y*z);", true);
        assert_eq!(r.code, "x/=(y*z);");
        assert_eq!(r.stats.aggressive.compound_assignments, 1);
    }

    #[test]
    fn merges_adjacent_same_type_declarations() {
        // Both locals are read afterwards (unlike earlier drafts of this
        // test) so dead-local elimination — which now runs first in the
        // pipeline — doesn't remove them out from under this test.
        let r = golf("void f(){float a=1.0;float b=2.0;x=a+b;}", true);
        assert_eq!(r.code, "void c(){float a=1.,b=2.;x=a+b;}");
        assert_eq!(r.stats.aggressive.declarations_merged, 1);
        assert_eq!(r.stats.renamed_count, 3);
    }

    #[test]
    fn does_not_bridge_merge_across_unrelated_statement() {
        let r = golf("void f(){float a=1.0;x=2.0;float b=3.0;y=a+b;}", true);
        // Must keep two separate `float` declarations: merging would
        // turn `float b=3.;` into a bare `,b=3.` glued onto the
        // preceding expression statement, which is not the same program.
        assert_eq!(r.code.matches("float").count(), 2);
        assert_eq!(r.stats.aggressive.declarations_merged, 0);
    }

    #[test]
    fn strips_braces_of_single_statement_if_body() {
        let r = golf("void f(){if(x){y=1.0;}}", true);
        assert_eq!(r.code, "void a(){if(x)y=1.;}");
        assert_eq!(r.stats.aggressive.braces_removed, 1);
    }

    #[test]
    fn refuses_to_strip_when_it_would_change_dangling_else_binding() {
        // Naively stripping both pairs of braces here would turn
        // `if(p){if(q)x;}else y;` (else belongs to p) into
        // `if(p)if(q)x;else y;` (else would now bind to q instead) —
        // a silent semantic change, not a syntax error.
        let r = golf("void h(){if(p){if(q)x;}else y;}", true);
        assert_eq!(r.code, "void a(){if(p){if(q)x;}else y;}");
        assert_eq!(r.stats.aggressive.braces_removed, 0);
    }

    #[test]
    fn refuses_to_strip_a_declaration_body() {
        // `if(x)float y=1.;` is not valid GLSL — a declaration is never
        // a valid brace-less body for if/for/while, unlike an ordinary
        // expression statement. ("y" is read afterwards so dead-local
        // elimination — which now runs first — doesn't remove the
        // declaration before this test ever exercises the guard.)
        let r = golf("void f(){if(x){float y=1.0;}z=y;}", true);
        assert_eq!(r.code, "void b(){if(x){float a=1.;}z=a;}");
        assert_eq!(r.stats.aggressive.braces_removed, 0);
    }

    #[test]
    fn strips_braces_of_single_statement_for_body() {
        let r = golf("void f(){for(int i=0;i<9;i++){x=1.0;}}", true);
        assert_eq!(r.code, "void b(){for(int a=0;a<9;a++)x=1.;}");
        assert_eq!(r.stats.aggressive.braces_removed, 1);
    }

    #[test]
    fn strips_braces_of_single_statement_do_while_body() {
        let r = golf("void f(){do{x=1.0;}while(x<9.0);}", true);
        assert_eq!(r.code, "void a(){do x=1.;while(x<9.);}");
        assert_eq!(r.stats.aggressive.braces_removed, 1);
    }

    #[test]
    fn keeps_multi_statement_block_but_recurses_into_it() {
        // The outer `if(x){...}` block holds two statements, so it must
        // keep its own braces — but the nested single-statement
        // `if(y){z=1.;}` inside it is still an independent, safe
        // stripping opportunity.
        let r = golf("void f(){if(x){if(y){z=1.0;}w=2.0;}}", true);
        assert_eq!(r.code, "void a(){if(x){if(y)z=1.;w=2.;}}");
        assert_eq!(r.stats.aggressive.braces_removed, 1);
    }

    #[test]
    fn folds_plain_int_multiplication() {
        let r = golf("x=2*3;", true);
        assert_eq!(r.code, "x=6;");
        assert_eq!(r.stats.aggressive.constants_folded, 1);
    }

    #[test]
    fn folds_a_left_associative_chain_in_one_pass() {
        let r = golf("x=2*3*4;", true);
        assert_eq!(r.code, "x=24;");
        assert_eq!(r.stats.aggressive.constants_folded, 2);
    }

    #[test]
    fn folds_truncating_integer_division_and_modulo() {
        let r = golf("x=7/2;", true);
        assert_eq!(r.code, "x=3;");
        let r = golf("x=7%3;", true);
        assert_eq!(r.code, "x=1;");
    }

    #[test]
    fn folds_multiplicative_then_additive_across_the_fixpoint_loop() {
        // `2+3*4` is `2+(3*4)`, not `(2+3)*4` — only the `3*4` (tightest
        // precedence) is safe to fold in a single left-to-right scan.
        // Historically this is where folding stopped entirely (`+` was
        // never folded at all) — now the Phase 0 fixpoint loop feeds the
        // `2+12` this produces back into additive folding on the next
        // iteration, reaching `14` fully rather than leaving a partially
        // folded expression on the table.
        let r = golf("x=2+3*4;", true);
        assert_eq!(r.code, "x=14;");
        assert_eq!(r.stats.aggressive.constants_folded, 2);
    }

    #[test]
    fn folds_a_simple_plus_and_minus() {
        let r = golf("x=1+2;", true);
        assert_eq!(r.code, "x=3;");
        let r = golf("x=3-5;", true);
        assert_eq!(r.code, "x=-2;");
    }

    #[test]
    fn folds_an_additive_chain_left_to_right() {
        let r = golf("x=1+2+3;", true);
        assert_eq!(r.code, "x=6;");
        let r = golf("x=3-5+10;", true);
        assert_eq!(r.code, "x=8;");
    }

    #[test]
    fn folds_a_leading_unary_sign_into_the_chain() {
        let r = golf("x=-5+3;", true);
        assert_eq!(r.code, "x=-2;");
    }

    #[test]
    fn refuses_to_fold_additive_chain_preceded_by_a_variable() {
        // `x-1+2` is `(x-1)+2` — folding the `1+2` tail alone would
        // silently turn this into `x-3`, which is wrong whenever `x` is
        // anything but the specific value that happens to make it not
        // matter. This exact case corrupted the output entirely
        // (`c 1` — tokens vanishing) before the boundary check was
        // fixed to treat a preceding identifier as unsafe, not just a
        // preceding `+`/`-`/`*`/`/`/`%`.
        let r = golf("x=y-1+2;", true);
        assert_eq!(r.code, "x=y-1+2;");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn refuses_to_fold_additive_chain_preceded_by_a_closing_bracket() {
        // Same reasoning as the variable case above, but for a function
        // call/array-index result instead of a bare identifier: `f()-1+2`
        // is `(f()-1)+2`, and the closing `)` is the tell that the `-`
        // is binary (subtracting from the call's result), not a leading
        // unary sign starting a fresh chain.
        let r = golf("x=f()-1+2;", true);
        assert_eq!(r.code, "x=f()-1+2;");
        let r = golf("x=a[0]-1+2;", true);
        assert_eq!(r.code, "x=a[0]-1+2;");
    }

    #[test]
    fn refuses_to_fold_across_a_following_tighter_operator_in_additive_chain() {
        // `1+2*3` is `1+(2*3)` — the `2` must not be folded into `1+2`.
        // Left alone, the existing `*`/`/`/`%` fold handles `2*3` on its
        // own, and thanks to the Phase 0 fixpoint loop a later iteration
        // then folds the now-adjacent `1+6`.
        let r = golf("x=1+2*3;", true);
        assert_eq!(r.code, "x=7;");
        let r = golf("x=1-2*3;", true);
        assert_eq!(r.code, "x=-5;");
    }

    #[test]
    fn refuses_to_fold_a_doubled_unary_sign() {
        // Unary `-` binds *tighter* than binary `+`, so `- -3+2` is
        // `(-(-3))+2` = `5`, not `-(-3+2)` = `1`. Treating the second
        // `-` as a valid unary chain start (it's preceded by the first
        // `-`) would silently compute the wrong value — declining here
        // is required for correctness, not just conservative caution.
        let r = golf("x=- -3+2;", true);
        assert_eq!(r.code, "x=- -3+2;");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn refuses_to_fold_additive_overflow() {
        let r = golf("x=2147483647+1;", true);
        assert_eq!(r.code, "x=2147483647+1;");
        let r = golf("x=-2147483648-1;", true);
        assert_eq!(r.code, "x=-2147483648-1;");
    }

    #[test]
    fn additive_and_multiplicative_folding_compose_across_the_fixpoint_loop() {
        // `4*3+2` is `(4*3)+2` = 14: `*` folds first (tightest
        // precedence), then the now-adjacent `12+2` folds on a later
        // fixpoint iteration — both increment the same `constants_folded`
        // counter (additive folding is the same "fold_constants" toggle
        // widened, not a separate pass/checkbox).
        let r = golf("x=4*3+2;", true);
        assert_eq!(r.code, "x=14;");
        assert_eq!(r.stats.aggressive.constants_folded, 2);
    }

    #[test]
    fn refuses_to_fold_division_by_zero() {
        let r = golf("x=5/0;", true);
        assert_eq!(r.code, "x=5/0;");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn refuses_to_fold_on_i32_overflow() {
        let r = golf("x=2000000000*3;", true);
        assert_eq!(r.code, "x=2000000000*3;");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn refuses_to_fold_hex_literals() {
        let r = golf("x=0xFF*2;", true);
        assert_eq!(r.code, "x=0xFF*2;");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn folded_constant_then_feeds_compound_assignment() {
        // Folding runs before compound-assignment rewriting, so a
        // folded RHS is itself eligible: `x=x*2*3;` -> `x=x*6;` -> `x*=6;`.
        let r = golf("x=x*2*3;", true);
        assert_eq!(r.code, "x*=6;");
        assert_eq!(r.stats.aggressive.constants_folded, 1);
        assert_eq!(r.stats.aggressive.compound_assignments, 1);
    }

    #[test]
    fn reduces_a_constant_vector_of_identical_literals() {
        let r = golf("void f(){vec3 a=vec3(1.0,1.0,1.0);}", true);
        assert_eq!(r.code, "void a(){vec3 b=vec3(1.);}");
        assert_eq!(r.stats.aggressive.constant_vectors_reduced, 1);
    }

    #[test]
    fn refuses_to_reduce_a_vector_of_differing_literals() {
        let r = golf("void f(){vec3 a=vec3(1.0,2.0,1.0);}", true);
        assert_eq!(r.code, "void a(){vec3 b=vec3(1.,2.,1.);}");
        assert_eq!(r.stats.aggressive.constant_vectors_reduced, 0);
    }

    #[test]
    fn refuses_to_reduce_a_vector_with_a_non_literal_argument() {
        // `w` is not a numeric literal, so the "all N arguments are the
        // exact same token" check can never hold — refusing here avoids
        // ever needing to reason about whether two different expressions
        // are semantically equal.
        let r = golf("void f(float w){vec3 a=vec3(w,w,w);}", true);
        assert_eq!(r.code, "void b(float a){vec3 c=vec3(a,a,a);}");
        assert_eq!(r.stats.aggressive.constant_vectors_reduced, 0);
    }

    #[test]
    fn reduces_constant_vec2_and_vec4() {
        let r = golf("void f(){vec2 a=vec2(1.,1.);}", true);
        assert_eq!(r.code, "void a(){vec2 b=vec2(1.);}");
        assert_eq!(r.stats.aggressive.constant_vectors_reduced, 1);
    }

    #[test]
    fn refuses_a_vector_with_more_arguments_than_its_arity() {
        // 5 arguments to a vec4(...) isn't valid GLSL to begin with, but
        // the pass must still not misfire on it: after matching 4
        // identical literals it expects `)`, finds `,` instead, and
        // bails out rather than guessing.
        let r = golf("void f(){vec4 a=vec4(1.,1.,1.,1.,1.);}", true);
        assert_eq!(r.code, "void a(){vec4 b=vec4(1.,1.,1.,1.,1.);}");
        assert_eq!(r.stats.aggressive.constant_vectors_reduced, 0);
    }

    #[test]
    fn folded_constants_feed_constant_vector_reduction() {
        // fold_constants runs first, so `2*3` becomes `6` in every slot
        // before reduce_constant_vectors ever looks at the arguments —
        // `vec3(2*3,2*3,2*3)` -> `vec3(6,6,6)` -> `vec3(6)`.
        let r = golf("void f(){vec3 a=vec3(2*3,2*3,2*3);}", true);
        assert_eq!(r.code, "void a(){vec3 b=vec3(6);}");
        assert_eq!(r.stats.aggressive.constants_folded, 3);
        assert_eq!(r.stats.aggressive.constant_vectors_reduced, 1);
    }

    #[test]
    fn strips_a_trailing_bare_return_in_a_void_function() {
        let r = golf("void f(){foo();return;}", true);
        assert_eq!(r.code, "void a(){foo();}");
        assert_eq!(r.stats.aggressive.trailing_void_returns_removed, 1);
    }

    #[test]
    fn strips_a_solitary_trailing_return() {
        let r = golf("void f(){return;}", true);
        assert_eq!(r.code, "void a(){}");
        assert_eq!(r.stats.aggressive.trailing_void_returns_removed, 1);
    }

    #[test]
    fn refuses_an_unbraced_if_bodied_trailing_return() {
        // The trap: `if(x)return;` looks token-wise identical to a real
        // standalone `return;` right before the closing `}`, but `if`
        // syntactically requires a statement to follow it — deleting
        // `return;` here would leave `if(x)}`, invalid GLSL. Caught by
        // requiring `return` to be immediately preceded by a statement
        // boundary (`;`/`{`/`}`), which `)` (from `if(x)`) is not.
        let r = golf("void f(){if(x)return;}", true);
        assert_eq!(r.code, "void a(){if(x)return;}");
        assert_eq!(r.stats.aggressive.trailing_void_returns_removed, 0);
    }

    #[test]
    fn refuses_the_same_trap_even_after_brace_stripping_exposes_it() {
        // `strip_redundant_braces` turns `if(x){return;}` into
        // `if(x)return;` earlier in the pipeline — the trailing-return
        // pass must still decline afterward, exactly as it would have
        // declined the already-unbraced form directly above.
        let r = golf("void f(){if(x){return;}}", true);
        assert_eq!(r.code, "void a(){if(x)return;}");
        assert_eq!(r.stats.aggressive.braces_removed, 1);
        assert_eq!(r.stats.aggressive.trailing_void_returns_removed, 0);
    }

    #[test]
    fn refuses_a_return_not_immediately_before_the_functions_own_close() {
        let r = golf("void f(){if(x)return;else bar();}", true);
        assert_eq!(r.code, "void a(){if(x)return;else bar();}");
        assert_eq!(r.stats.aggressive.trailing_void_returns_removed, 0);
    }

    #[test]
    fn refuses_a_return_carrying_a_value() {
        // Not a *bare* `return;` — `return` isn't immediately followed
        // by `;`, so this never matches regardless of function type.
        let r = golf("float f(){return 1.0;}", true);
        assert_eq!(r.code, "float a(){return 1.;}");
        assert_eq!(r.stats.aggressive.trailing_void_returns_removed, 0);
    }

    #[test]
    fn removes_a_local_never_referenced_again() {
        let r = golf("void f(){float unused=1.0;x=2.0;}", true);
        assert_eq!(r.code, "void a(){x=2.;}");
        assert_eq!(r.stats.aggressive.dead_locals_removed, 1);
    }

    #[test]
    fn removes_an_uninitialized_dead_local() {
        let r = golf("void f(){float unused;x=2.0;}", true);
        assert_eq!(r.code, "void a(){x=2.;}");
        assert_eq!(r.stats.aggressive.dead_locals_removed, 1);
    }

    #[test]
    fn refuses_to_remove_a_local_that_is_read_later() {
        let r = golf("void f(){float used=1.0;x=used;}", true);
        assert_eq!(r.code, "void b(){float a=1.;x=a;}");
        assert_eq!(r.stats.aggressive.dead_locals_removed, 0);
    }

    #[test]
    fn refuses_to_remove_when_initializer_calls_a_function() {
        // The initializer must be a single bare identifier/literal —
        // `foo(y)` fails because the token right after the bare `foo`
        // operand has to be `;`, and it's `(` instead. A function call
        // might have side effects (e.g. writing an `out` parameter),
        // so this pass never guesses about what's inside one.
        let r = golf("void f(){float unused=foo(y);x=2.0;}", true);
        assert_eq!(r.code, "void a(){float b=foo(y);x=2.;}");
        assert_eq!(r.stats.aggressive.dead_locals_removed, 0);
    }

    #[test]
    fn refuses_to_remove_an_array_declarator() {
        let r = golf("void f(){float unused[3];x=2.0;}", true);
        assert_eq!(r.code, "void a(){float b[3];x=2.;}");
        assert_eq!(r.stats.aggressive.dead_locals_removed, 0);
    }

    #[test]
    fn dead_local_removal_can_enable_a_later_declaration_merge() {
        // Removing the dead `unused` decl makes the two surviving
        // `float` declarations adjacent, which merge_declarations (run
        // afterwards) then combines — a pass ordering deliberately
        // chosen so these two passes compose.
        let r = golf("void f(){float p=1.0;float unused=2.0;float q=3.0;x=p+q;}", true);
        assert_eq!(r.code, "void c(){float a=1.,b=3.;x=a+b;}");
        assert_eq!(r.stats.aggressive.dead_locals_removed, 1);
        assert_eq!(r.stats.aggressive.declarations_merged, 1);
    }

    #[test]
    fn struct_member_named_like_a_swizzle_is_never_renamed() {
        // Before this was fixed, `float x;` inside the struct body
        // matched the same "<type> <ident>" declaration heuristic as
        // any ordinary local, so `x` got renamed everywhere it appeared
        // as a bare identifier — including `p.x`, an unrelated swizzle
        // access on a completely different vec3. That produced
        // `p.a` (or whatever `x` got renamed to): not a valid GLSL
        // swizzle, a silent compile break from otherwise-correct input.
        let r = golf(
            "struct Foo{float x;float y;};void mainImage(out vec4 fragColor,in vec2 fragCoord){Foo f;f.x=1.0;f.y=2.0;vec3 p=vec3(1.0,2.0,3.0);vec3 q=p.xyz+p.x;fragColor=vec4(q,f.x+f.y);}",
            false,
        );
        assert_eq!(
            r.code,
            "struct b{float x;float y;};void mainImage(out vec4 c,in vec2 e){b f;f.x=1.;f.y=2.;vec3 a=vec3(1.,2.,3.);vec3 d=a.xyz+a.x;c=vec4(d,f.x+f.y);}"
        );
    }

    #[test]
    fn unrecognized_struct_instance_name_is_protected_from_collision() {
        // `W` isn't a built-in type keyword, so `W a;` was never
        // detected as a declaration — "a" silently kept its original
        // spelling. But nothing protected that spelling from being
        // handed out to some *other* renamed variable, so the
        // highest-frequency local here could end up renamed to "a" too:
        // two different variables declared under the same name in the
        // same scope. `taken` must include every identifier the source
        // already uses, not just the ones this pass renames.
        let r = golf(
            "struct W{float v;};void h(){W a;float longName=1.0;longName=longName+1.0;}",
            false,
        );
        assert_eq!(r.code, "struct c{float v;};void d(){c a;float b=1.;b=b+1.;}");
    }

    #[test]
    fn name_referenced_only_inside_a_macro_body_is_protected_from_collision() {
        // `a` is a real, valid macro (`#define a 3.0`), referenced only
        // from inside another macro's body (`#define TAU (2.0*a)`) —
        // never as a bare token in actual code. `#define` lines are
        // kept verbatim and never tokenized past their raw text, so
        // without protecting this spelling, NameGen's very first
        // candidate ("a") would be handed to the one real local here,
        // producing `float a=1.;` alongside the untouched `#define a
        // 3.0` — the real GLSL preprocessor would then substitute that
        // macro into its own declaration (`float 3.0=1.;`), which
        // doesn't even parse. Pins that the local gets "b" instead,
        // leaving "a" alone for the macro.
        let r = golf(
            "#define a 3.0\n#define TAU (2.0*a)\nvoid mainImage(out vec4 fragColor,in vec2 fragCoord){float velocity=1.0;fragColor=vec4(velocity+TAU);}",
            false,
        );
        assert_eq!(
            r.code,
            "#define a 3.0\n#define TAU (2.0*a)\nvoid mainImage(out vec4 b,in vec2 d){float c=1.;b=vec4(c+TAU);}"
        );
    }

    #[test]
    fn protected_names_are_never_renamed() {
        // A custom uniform a host app binds by name — not one of the
        // fixed Shadertoy uniforms, so nothing protects it by default.
        let r = golf_with_protected_names(
            "uniform float uSpeed;void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(uSpeed);}",
            AggressiveOptions::none(),
            &["uSpeed".to_string()],
        );
        assert!(r.code.contains("uSpeed"), "protected name must survive verbatim: {}", r.code);
    }

    #[test]
    fn protected_names_also_reserve_the_spelling_from_reuse() {
        // Protecting `keep` must also stop some *other* variable from
        // being renamed *to* "keep" -- otherwise two different
        // variables would end up declared under the same name.
        let r = golf_with_protected_names(
            "uniform float keep;void mainImage(out vec4 fragColor,in vec2 fragCoord){float longLocalName=1.0;fragColor=vec4(keep+longLocalName);}",
            AggressiveOptions::none(),
            &["keep".to_string()],
        );
        assert!(!r.code.contains("float keep="), "the spelling \"keep\" must never be handed to a different variable: {}", r.code);
        assert!(r.code.contains("keep"), "the protected uniform must still appear under its own name: {}", r.code);
    }

    #[test]
    fn declaration_heuristic_ignores_non_type_keywords() {
        // `else`/`return`/other qualifiers and control-flow keywords are
        // never immediately followed by a declared identifier in real
        // GLSL — a declaration's type token always sits directly next
        // to the name. Renaming based on *any* keyword-then-identifier
        // pair (the old behaviour) produced harmless but surprising
        // renames like `else y` -> `else b`. `void` still introduces a
        // function's name (`void f()`), and `struct Foo` still
        // introduces the struct's own type name — both keep working.
        let r = golf("void f(){return z;}", false);
        assert_eq!(r.code, "void a(){return z;}");

        let r = golf("struct Foo{float x;};void f(){Foo a;}", false);
        assert_eq!(r.code, "struct b{float x;};void c(){b a;}");
    }

    #[test]
    fn protects_a_declared_name_also_referenced_inside_a_macro_body() {
        // `#define` bodies are opaque, never-tokenized text — renaming a
        // declaration whose name is *also* used inside a macro desyncs
        // the two: the preprocessor still expands the macro with the
        // old name, which no longer exists anywhere after renaming.
        // `OFFSET` here must keep its exact spelling for the expanded
        // `GET_X(fragCoord)` call to still compile.
        let r = golf(
            "#define GET_X(p) (p.x + OFFSET)\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord){float OFFSET = 1.0;fragColor=vec4(GET_X(fragCoord),0.0,0.0,1.0);}",
            false,
        );
        assert_eq!(
            r.code,
            "#define GET_X(p) (p.x + OFFSET)\nvoid mainImage(out vec4 a,in vec2 b){float OFFSET=1.;a=vec4(GET_X(b),0.,0.,1.);}"
        );
    }

    #[test]
    fn scope_aware_renaming_reuses_short_names_across_independent_functions() {
        // Three functions, each with their own param + local, called
        // from nowhere but each other — a flat (non-scope-aware) renamer
        // would need 8 distinct letters (one per declaration, file-wide).
        // A scope-aware one only needs 4: "a" and "d" for the two
        // globally-visible helper names (mainImage is protected, so it
        // keeps its name), and "b"/"c" reused independently inside all
        // three function bodies, since none of them can see into
        // another's locals.
        let r = golf(
            "float helperOne(float longParamName){float localVarOne=longParamName*2.0;return localVarOne;}\nfloat helperTwo(float anotherParam){float localVarTwo=anotherParam+1.0;return localVarTwo;}\nvoid mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(helperOne(1.0)+helperTwo(2.0),0.0,0.0,1.0);}",
            false,
        );
        assert_eq!(
            r.code,
            "float a(float b){float c=b*2.;return c;}float d(float b){float c=b+1.;return c;}void mainImage(out vec4 b,in vec2 c){b=vec4(a(1.)+d(2.),0.,0.,1.);}"
        );
    }

    #[test]
    fn eliminates_a_chain_of_adjacent_dead_stores() {
        // Each write is immediately superseded by the next with no read
        // in between, so only the last ("x=3.;") survives.
        let r = golf("void f(){x=1.0;x=2.0;x=3.0;foo(x);}", true);
        assert_eq!(r.code, "void a(){x=3.;foo(x);}");
        assert_eq!(r.stats.aggressive.dead_stores_removed, 2);
    }

    #[test]
    fn reduces_a_dead_initializer_to_a_bare_declaration() {
        // The declaration itself must survive (removing it would
        // undeclare `x` before its second, live write) — only the
        // wasted `=1.0` initializer is dropped.
        let r = golf("void f(){float x=1.0;x=2.0;foo(x);}", true);
        assert_eq!(r.code, "void b(){float a;a=2.;foo(a);}");
        assert_eq!(r.stats.aggressive.dead_stores_removed, 1);
    }

    #[test]
    fn refuses_to_drop_a_write_the_next_statement_reads() {
        // `x=x;` reads the prior value of x before rewriting it, so the
        // first write is not actually dead.
        let r = golf("void f(){x=1.0;x=x;foo(x);}", true);
        assert_eq!(r.code, "void a(){x=1.;x=x;foo(x);}");
        assert_eq!(r.stats.aggressive.dead_stores_removed, 0);
    }

    #[test]
    fn refuses_to_treat_a_compound_assignment_as_superseding() {
        // `x+=2.0` reads x (to add to it), so the prior write is live.
        let r = golf("void f(){x=1.0;x+=2.0;foo(x);}", true);
        assert_eq!(r.code, "void a(){x=1.;x+=2.;foo(x);}");
        assert_eq!(r.stats.aggressive.dead_stores_removed, 0);
    }

    #[test]
    fn never_matches_a_for_headers_own_clauses() {
        // `int i=0;i<9;i++` inside a for-header must never be treated
        // as two adjacent statements, even though it's textually
        // `IDENT = ...; ...` shaped where a real statement boundary
        // would be — depth-tracking excludes anything inside `(...)`.
        let r = golf("void f(){for(int i=0;i<9;i++){x+=1.0;}}", true);
        assert_eq!(r.code, "void b(){for(int a=0;a<9;a++)++x;}");
        assert_eq!(r.stats.aggressive.dead_stores_removed, 0);
    }

    #[test]
    fn does_not_catch_dead_stores_separated_by_another_statement() {
        // Documented scope limit: only *directly adjacent* pairs are
        // considered. `x=1.0;y=2.0;x=3.0;` has a dead `x=1.0;` too, but
        // proving that safely would need real liveness analysis across
        // the intervening `y=2.0;` — declined rather than risk it.
        let r = golf("void f(){x=1.0;y=2.0;x=3.0;foo(x,y);}", true);
        assert_eq!(r.code, "void a(){x=1.;y=2.;x=3.;foo(x,y);}");
        assert_eq!(r.stats.aggressive.dead_stores_removed, 0);
    }

    #[test]
    fn strips_parens_around_a_single_literal() {
        let r = golf("void f(){float a=(1.0);foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=1.;foo(a);}");
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 1);
    }

    #[test]
    fn strips_nested_parens_via_the_fixpoint_loop() {
        // Each iteration of the fixpoint loop only strips one layer, so
        // `((1.0))` needs two passes: `(1.0)` -> `1.0` first, then the
        // now-bare `(1.0)` on the next iteration.
        let r = golf("void f(){float a=((1.0));foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=1.;foo(a);}");
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 2);
    }

    #[test]
    fn refuses_parens_around_more_than_one_primary() {
        // `scan_primary` only consumes a single primary expression, so
        // it stops at `x` while the closing `)` is after `+y` -- the
        // mismatch means the parens are load-bearing and must stay.
        // Uses variables rather than float literals so this exercises
        // `strip_redundant_parens` in isolation, without the separate
        // float constant-folding pass folding `1.0+2.0` away first.
        let r = golf("void f(){float a=(x+y);foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=(x+y);foo(a);}");
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 0);
    }

    #[test]
    fn refuses_a_real_function_calls_parens() {
        // Preceded by an identifier (`vec3`), so this is a call, not a
        // grouping paren -- must never be touched. The *inner* redundant
        // parens around the single argument still get stripped though.
        let r = golf("void f(){vec3 a=vec3((1.0));foo(a);}", true);
        assert_eq!(r.code, "void b(){vec3 a=vec3(1.);foo(a);}");
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 1);
    }

    #[test]
    fn refuses_a_control_flow_keywords_mandatory_parens() {
        // `if` tokenizes as the same `Tok::Ident` variant as any other
        // identifier, so the "preceded by an identifier" exclusion also
        // protects `if(...)`'s parens for free -- even though the inner
        // `(true)` is itself a redundant single-primary paren that gets
        // stripped by a separate, unrelated match.
        let r = golf("void f(){if((true)){foo();}}", true);
        assert_eq!(r.code, "void a(){if(true)foo();}");
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 1);
    }

    #[test]
    fn refuses_parens_around_a_binary_expression_used_as_an_operand() {
        let r = golf("void f(){float a=(x+y)*2.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=(x+y)*2.;foo(a);}");
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 0);
    }

    #[test]
    fn preserves_a_disambiguating_space_after_stripping_parens_around_a_unary_minus() {
        // Regression test: deleting the `(` used to leave the `-` from
        // `5.-` textually adjacent to the unary `-` that was originally
        // right after `(` with no space (`(-x)`), producing `5.--x` --
        // indistinguishable from (or at least confusable with) the
        // decrement operator. The fix forces `space_before` on the
        // first re-emitted inner token so `layout()`'s ambiguous-pair
        // guard actually runs and inserts the disambiguating space.
        let r = golf("void f(){float x=1.0;float a;a=5.0-(-x);foo(a);}", true);
        assert_eq!(r.code, "void c(){float b=1.,a;a=5.- -b;foo(a);}");
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 1);
    }

    #[test]
    fn preserves_a_disambiguating_space_after_stripping_parens_around_a_unary_plus() {
        let r = golf("void f(){float x=1.0;float a;a=5.0+(+x);foo(a);}", true);
        assert_eq!(r.code, "void c(){float b=1.,a;a=5.+ +b;foo(a);}");
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 1);
    }

    #[test]
    fn does_not_force_an_unnecessary_space_when_no_fusion_risk_exists() {
        // `*` immediately followed by `-` never forms an ambiguous pair
        // (there's no `*-` operator to be confused with), so forcing
        // `space_before` on the re-emitted token must not itself cause
        // an unwanted space to appear.
        let r = golf("void f(){float x=1.0;float a;a=5.0*(-x);foo(a);}", true);
        assert_eq!(r.code, "void c(){float b=1.,a;a=5.*-b;foo(a);}");
        assert_eq!(r.stats.aggressive.redundant_parens_removed, 1);
    }

    #[test]
    fn folds_a_float_multiplication() {
        let r = golf("void f(){float a=2.0*3.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=6.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 1);
    }

    #[test]
    fn folds_a_float_multiplication_chain() {
        // Counted as 2 folds, not 1: `fold_float_constants` folds
        // `2.0*3.0` first, then sees its own freshly-pushed `6.` as the
        // new left operand for `*4.0` in the same call (same
        // left-to-right greedy behavior as `fold_constants` for ints).
        let r = golf("void f(){float a=2.0*3.0*4.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=24.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 2);
    }

    #[test]
    fn folds_a_float_additive_chain() {
        let r = golf("void f(){float a=1.0+2.0+3.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=6.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 1);
    }

    #[test]
    fn folds_a_negative_float_result() {
        let r = golf("void f(){float a=3.0-5.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=-2.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 1);
    }

    #[test]
    fn folds_a_leading_unary_sign_into_a_float_chain() {
        let r = golf("void f(){float a=-5.0+3.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=-2.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 1);
    }

    #[test]
    fn refuses_to_fold_a_float_additive_chain_preceded_by_a_variable() {
        // Same trap as the int version: `x-1.0+2.0` must not be folded
        // into `x-3.0`, since the `-` here is binary (subtracting from
        // `x`), not a unary chain-start.
        let r = golf("void f(){float a=x-1.0+2.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=x-1.+2.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn refuses_to_fold_float_division() {
        // Deliberately out of scope (ROADMAP.md Phase 1.1): division is
        // where imprecision is structurally most likely.
        let r = golf("void f(){float a=1.0/2.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=1./2.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn refuses_float_literals_with_an_exponent_or_suffix() {
        let r = golf("void f(){float a=1.0e5*2.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=1.e5*2.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 0);

        let r = golf("void f(){float a=1.0f*2.0f;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=1.f*2.f;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn refuses_to_fold_a_float_multiplication_that_overflows_to_infinity() {
        // The safe pipeline's number-shortening (ROADMAP.md Phase 1.1)
        // now shortens this literal to `1e30` before the aggressive
        // pass even runs — which then also makes it ineligible for
        // folding for an *additional*, independent reason
        // (`parse_plain_float` declines any literal with an exponent).
        // Either reason alone is enough to decline; both hold here.
        let r = golf(
            "void f(){float a=999999999999999999999999999999.0*999999999999999999999999999999.0;foo(a);}",
            true,
        );
        assert_eq!(r.code, "void b(){float a=1e30*1e30;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn refuses_to_fold_a_float_chain_that_would_produce_negative_zero() {
        // `-0.0-0.0` accumulates to a literal negative zero, which
        // `format_folded_float` declines rather than try to correctly
        // re-attach a `-` sign to an otherwise-zero magnitude — the
        // chain is left completely unfolded rather than half-applied.
        let r = golf("void f(){float a=-0.0-0.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=-0.-0.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 0);
    }

    #[test]
    fn float_multiplication_then_addition_compose_across_the_fixpoint_loop() {
        // `3.0*4.0` folds to `12.` in the multiplicative pass, then the
        // now-adjacent `2.0+12.` folds on the next fixpoint iteration —
        // same cascade pattern as the int version.
        let r = golf("void f(){float a=2.0+3.0*4.0;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=14.;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 2);
    }

    #[test]
    fn folds_a_float_result_that_needs_host_precision_agreement() {
        // `0.1+0.2` is the textbook float-imprecision trap in most
        // languages' default (f64) arithmetic -- but done in `f32`
        // (matching what a GLSL `highp` compiler must produce), it
        // rounds to exactly the `f32` value whose shortest text is
        // `0.3`, same as GLSL would compute at runtime.
        let r = golf("void f(){float a=0.1+0.2;foo(a);}", true);
        assert_eq!(r.code, "void b(){float a=0.3;foo(a);}");
        assert_eq!(r.stats.aggressive.constants_folded, 1);
    }

    #[test]
    fn shortens_a_large_whole_number_to_scientific_notation() {
        // "1000000." (8 chars) vs "1e6" (3 chars) — scientific wins.
        // Uses the safe pipeline only (no `-a`): this is number
        // shortening, not aggressive constant folding.
        let r = golf("void f(){float a=1000000.0;foo(a);}", false);
        assert_eq!(r.code, "void b(){float a=1e6;foo(a);}");
        assert_eq!(r.stats.numbers_shortened, 1);
    }

    #[test]
    fn shortens_a_small_fraction_to_scientific_notation() {
        // ".0001" (5 chars) vs "1e-4" (4 chars) — scientific wins.
        let r = golf("void f(){float a=0.0001;foo(a);}", false);
        assert_eq!(r.code, "void b(){float a=1e-4;foo(a);}");
    }

    #[test]
    fn keeps_decimal_form_when_it_is_already_shorter() {
        // "123456." (7 chars) vs "1.23456e5" (9 chars) — decimal wins.
        let r = golf("void f(){float a=123456.0;foo(a);}", false);
        assert_eq!(r.code, "void b(){float a=123456.;foo(a);}");
    }

    #[test]
    fn keeps_decimal_form_on_an_exact_tie() {
        // ".000123" and "1.23e-4" are both 7 characters — ties favor
        // the plain decimal form (strict `<` comparison, not `<=`).
        let r = golf("void f(){float a=0.000123;foo(a);}", false);
        assert_eq!(r.code, "void b(){float a=.000123;foo(a);}");
    }

    #[test]
    fn never_converts_a_bare_integer_to_scientific_notation() {
        // Critical guard: `1000000` (an `int` literal, no `.`) must
        // never become `1e6` — that would silently change its GLSL
        // type from `int` to `float`, breaking e.g. an array size or a
        // loop counter that requires an `int`.
        let r = golf("void f(){int a[1000000];foo(a[0]);}", false);
        assert_eq!(r.code, "void b(){int a[1000000];foo(a[0]);}");
        assert_eq!(r.stats.numbers_shortened, 0);
    }

    #[test]
    fn leaves_a_literal_that_already_has_an_exponent_untouched_by_this_comparison() {
        // Out of scope for this first version: re-deriving a shorter
        // exponent for a literal that already uses one.
        let r = golf("void f(){float a=1.5e10;foo(a);}", false);
        assert_eq!(r.code, "void b(){float a=1.5e10;foo(a);}");
    }

    #[test]
    fn scientific_notation_correctly_carries_a_type_suffix() {
        let r = golf("void f(){float a=1000000.0f;foo(a);}", false);
        assert_eq!(r.code, "void b(){float a=1e6f;foo(a);}");
    }

    #[test]
    fn strips_an_exact_duplicate_precision_statement() {
        let r = golf(
            "precision highp float;precision highp float;void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(1.0);}",
            true,
        );
        assert_eq!(
            r.code,
            "precision highp float;void mainImage(out vec4 a,in vec2 b){a=vec4(1.);}"
        );
        assert_eq!(r.stats.aggressive.duplicate_precision_removed, 1);
    }

    #[test]
    fn collapses_a_triple_duplicate_precision_statement_to_one() {
        let r = golf(
            "precision highp float;precision highp float;precision highp float;void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(1.0);}",
            true,
        );
        assert_eq!(
            r.code,
            "precision highp float;void mainImage(out vec4 a,in vec2 b){a=vec4(1.);}"
        );
        assert_eq!(r.stats.aggressive.duplicate_precision_removed, 2);
    }

    #[test]
    fn keeps_a_single_precision_statement_untouched() {
        // Critical guard: never strip the *only* precision statement
        // for a type, even though it might look redundant against this
        // app's own renderer-injected header — see the section comment
        // on `strip_duplicate_precision` for why that broader removal
        // is a real, not hypothetical, compile-error risk in any other
        // consumer of the golfed text.
        let r = golf(
            "precision highp float;void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(1.0);}",
            true,
        );
        assert_eq!(
            r.code,
            "precision highp float;void mainImage(out vec4 a,in vec2 b){a=vec4(1.);}"
        );
        assert_eq!(r.stats.aggressive.duplicate_precision_removed, 0);
    }

    #[test]
    fn keeps_precision_statements_that_differ_in_qualifier() {
        let r = golf(
            "precision highp float;precision mediump float;void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(1.0);}",
            true,
        );
        assert_eq!(
            r.code,
            "precision highp float;precision mediump float;void mainImage(out vec4 a,in vec2 b){a=vec4(1.);}"
        );
        assert_eq!(r.stats.aggressive.duplicate_precision_removed, 0);
    }

    #[test]
    fn keeps_precision_statements_that_differ_in_type() {
        let r = golf(
            "precision highp float;precision highp int;void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(1.0);}",
            true,
        );
        assert_eq!(
            r.code,
            "precision highp float;precision highp int;void mainImage(out vec4 a,in vec2 b){a=vec4(1.);}"
        );
        assert_eq!(r.stats.aggressive.duplicate_precision_removed, 0);
    }

    #[test]
    fn removes_a_function_never_called_from_mainimage() {
        let r = golf(
            "float unused(float x){return x*2.0;}void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(1.0);}",
            true,
        );
        assert_eq!(r.code, "void mainImage(out vec4 a,in vec2 c){a=vec4(1.);}");
        assert_eq!(r.stats.aggressive.dead_functions_removed, 1);
    }

    #[test]
    fn keeps_a_function_called_from_mainimage() {
        let r = golf(
            "float helper(float x){return x*2.0;}void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(helper(1.0));}",
            true,
        );
        assert_eq!(
            r.code,
            "float a(float b){return b*2.;}void mainImage(out vec4 b,in vec2 c){b=vec4(a(1.));}"
        );
        assert_eq!(r.stats.aggressive.dead_functions_removed, 0);
    }

    #[test]
    fn keeps_a_function_reachable_only_transitively() {
        // mainImage calls `a`, which calls `b` -- `b` is never called
        // *directly* by an entry point, only reachable through the
        // call graph, and must still survive.
        let r = golf(
            "float a(float x){return b(x);}float b(float x){return x*2.0;}void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(a(1.0));}",
            true,
        );
        assert_eq!(
            r.code,
            "float b(float a){return c(a);}float c(float a){return a*2.;}void mainImage(out vec4 d,in vec2 e){d=vec4(b(1.));}"
        );
        assert_eq!(r.stats.aggressive.dead_functions_removed, 0);
    }

    #[test]
    fn removes_a_mutually_recursive_pair_thats_unreachable_from_any_entry_point() {
        // `dead2` calls `dead1`, and `dead1` has no callers either --
        // neither is reachable from `mainImage`, so the reachability
        // walk (not just "does something call it") must remove both,
        // not just the one with zero callers.
        let r = golf(
            "float dead1(){return 1.0;}float dead2(){return dead1();}void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(1.0);}",
            true,
        );
        assert_eq!(r.code, "void mainImage(out vec4 b,in vec2 d){b=vec4(1.);}");
        assert_eq!(r.stats.aggressive.dead_functions_removed, 2);
    }

    #[test]
    fn keeps_all_overloads_of_a_reachable_name() {
        // No type information here to tell which overload a call site
        // resolves to, so a call to `f` conservatively keeps *every*
        // definition named `f` -- never guesses which one is "the"
        // live overload.
        let r = golf(
            "float f(float x){return x;}float f(vec2 x){return x.x;}void mainImage(out vec4 fragColor,in vec2 fragCoord){fragColor=vec4(f(1.0));}",
            true,
        );
        assert_eq!(
            r.code,
            "float b(float a){return a;}float b(vec2 a){return a.x;}void mainImage(out vec4 c,in vec2 d){c=vec4(b(1.));}"
        );
        assert_eq!(r.stats.aggressive.dead_functions_removed, 0);
    }

    #[test]
    fn declines_entirely_when_there_is_no_recognized_entry_point() {
        // A `Common`-only buffer with helper functions but no
        // `mainImage`/`main` of its own (ROADMAP.md Phase 4) -- there is
        // no safe root to walk reachability from, so nothing is removed
        // at all rather than treating every function as dead.
        let r = golf("float helper(float x){return x*2.0;}", true);
        assert_eq!(r.code, "float b(float a){return a*2.;}");
        assert_eq!(r.stats.aggressive.dead_functions_removed, 0);
    }
}
