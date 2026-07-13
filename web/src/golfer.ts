/**
 * glsl-golf-core (TypeScript port)
 *
 * A faithful port of the Rust engine in `rust-core/`. Kept in lockstep
 * with it deliberately: same passes, same protected-name tables, same
 * edge-case handling (see comments marked "(bug fix)" — these were
 * found by testing against the real fractal shader and are the reason
 * this is a real golfer rather than the original app's fixed string).
 *
 * Passes:
 *   1. tokenize (strip comments, track original whitespace-adjacency)
 *   2. discover renamable identifiers (frequency-ranked, protected
 *      names / keywords / builtins excluded)
 *   3. shorten numeric literals without changing their value
 *   4. minimal-whitespace layout, guarding against accidental token
 *      fusion (both "wordA wordB" -> "wordAwordB" and "- -" -> "--")
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const KEYWORDS = new Set([
  "attribute", "const", "uniform", "varying", "buffer", "shared", "coherent",
  "volatile", "restrict", "readonly", "writeonly", "atomic_uint", "layout",
  "centroid", "flat", "smooth", "noperspective", "patch", "sample",
  "invariant", "precise", "break", "continue", "do", "for", "while",
  "switch", "case", "default", "if", "else", "subroutine", "in", "out",
  "inout", "true", "false", "discard", "return", "struct", "void",
  "precision", "highp", "mediump", "lowp",
  "float", "double", "int", "uint", "bool", "vec2", "vec3", "vec4", "dvec2",
  "dvec3", "dvec4", "bvec2", "bvec3", "bvec4", "ivec2", "ivec3", "ivec4",
  "uvec2", "uvec3", "uvec4", "mat2", "mat3", "mat4", "mat2x2", "mat2x3",
  "mat2x4", "mat3x2", "mat3x3", "mat3x4", "mat4x2", "mat4x3", "mat4x4",
  "sampler2D", "sampler3D", "samplerCube", "sampler2DShadow",
  "samplerCubeShadow", "sampler2DArray", "sampler2DArrayShadow",
  "isampler2D", "isampler3D", "isamplerCube", "isampler2DArray",
  "usampler2D", "usampler3D", "usamplerCube", "usampler2DArray",
  "image2D", "iimage2D", "uimage2D",
]);

export const BUILTIN_FUNCTIONS = new Set([
  "radians", "degrees", "sin", "cos", "tan", "asin", "acos", "atan", "sinh",
  "cosh", "tanh", "asinh", "acosh", "atanh", "pow", "exp", "log", "exp2",
  "log2", "sqrt", "inversesqrt", "abs", "sign", "floor", "trunc", "round",
  "roundEven", "ceil", "fract", "mod", "modf", "min", "max", "clamp", "mix",
  "step", "smoothstep", "isnan", "isinf", "floatBitsToInt",
  "floatBitsToUint", "intBitsToFloat", "uintBitsToFloat", "fma", "frexp",
  "ldexp", "packUnorm2x16", "packSnorm2x16", "packUnorm4x8", "packSnorm4x8",
  "unpackUnorm2x16", "unpackSnorm2x16", "unpackUnorm4x8", "unpackSnorm4x8",
  "packHalf2x16", "unpackHalf2x16", "length", "distance", "dot", "cross",
  "normalize", "faceforward", "reflect", "refract", "matrixCompMult",
  "outerProduct", "transpose", "determinant", "inverse", "lessThan",
  "lessThanEqual", "greaterThan", "greaterThanEqual", "equal", "notEqual",
  "any", "all", "not", "textureSize", "texture", "textureProj",
  "textureLod", "textureOffset", "texelFetch", "texelFetchOffset",
  "textureProjOffset", "textureLodOffset", "textureProjLod",
  "textureProjLodOffset", "textureGrad", "textureGradOffset",
  "textureProjGrad", "textureProjGradOffset", "texture2D", "texture2DProj",
  "textureCube", "dFdx", "dFdy", "fwidth", "noise1", "noise2", "noise3",
  "noise4", "EmitVertex", "EndPrimitive", "barrier",
]);

export const BUILTIN_VARIABLES = new Set([
  "gl_FragCoord", "gl_FragColor", "gl_FragData", "gl_FrontFacing",
  "gl_PointCoord", "gl_Position", "gl_PointSize", "gl_VertexID",
  "gl_InstanceID", "gl_FragDepth",
]);

// Host-referenced names: JS looks these up by string, so they must
// never be renamed.
export const PROTECTED_HOST_NAMES = new Set([
  "main", "mainImage", "iResolution", "iTime", "iTimeDelta", "iFrame",
  "iMouse", "iDate", "iSampleRate", "iChannel0", "iChannel1", "iChannel2",
  "iChannel3",
]);

// The subset of KEYWORDS that names an actual GLSL type (as opposed to
// a qualifier like `const`/`uniform` or control-flow keyword). Used by
// the aggressive declaration-fusion pass — see mergeDeclarations().
export const TYPE_KEYWORDS = new Set([
  "float", "double", "int", "uint", "bool", "vec2", "vec3", "vec4", "dvec2",
  "dvec3", "dvec4", "bvec2", "bvec3", "bvec4", "ivec2", "ivec3", "ivec4",
  "uvec2", "uvec3", "uvec4", "mat2", "mat3", "mat4", "mat2x2", "mat2x3",
  "mat2x4", "mat3x2", "mat3x3", "mat3x4", "mat4x2", "mat4x3", "mat4x4",
  "sampler2D", "sampler3D", "samplerCube", "sampler2DShadow",
  "samplerCubeShadow", "sampler2DArray", "sampler2DArrayShadow",
  "isampler2D", "isampler3D", "isamplerCube", "isampler2DArray",
  "usampler2D", "usampler3D", "usamplerCube", "usampler2DArray",
  "image2D", "iimage2D", "uimage2D",
]);

// The keywords that can legitimately introduce a declaration when
// immediately followed by a user identifier: every real type, plus
// `struct` itself (`struct Foo{...}` — Foo is the struct's own type
// name, still safe and worth renaming, unlike its *members*) and `void`
// (not a variable type, but exactly how a function's return type
// introduces the function's name). Deliberately narrower than
// KEYWORDS: qualifiers (`const`/`uniform`/...) and control-flow
// keywords (`if`/`else`/`for`/`return`/...) are excluded because a
// user identifier immediately after one of those is never a
// declaration — a declaration's type token is always the one directly
// adjacent to the name. Using the wider KEYWORDS set here caused a
// real (if harmless) false positive: `if(p){if(q)x;}else y;` renamed
// `y` because `else` is a keyword immediately followed by a bare
// identifier.
export const DECLARATION_INTRODUCERS = new Set([...TYPE_KEYWORDS, "struct", "void"]);

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokKind = "preproc" | "ident" | "number" | "punct";
interface Token {
  kind: TokKind;
  text: string;
  /** Was this token separated from the previous one by whitespace/comments? */
  spaceBefore: boolean;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}
function isAlpha(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isAlnum(c: string): boolean {
  return isAlpha(c) || isDigit(c);
}
function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

export function tokenize(src: string): Token[] {
  const n = src.length;
  let i = 0;
  const out: Token[] = [];
  let spaceBefore = true; // start-of-file

  while (i < n) {
    const c = src[i];

    // Line comment
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      spaceBefore = true;
      continue;
    }
    // Block comment
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      spaceBefore = true;
      continue;
    }
    // Preprocessor directive
    if (c === "#") {
      const start = i;
      while (i < n && src[i] !== "\n") i++;
      out.push({ kind: "preproc", text: src.slice(start, i).trim(), spaceBefore: true });
      spaceBefore = true;
      continue;
    }
    // Whitespace
    if (isSpace(c)) {
      i++;
      spaceBefore = true;
      continue;
    }
    // Numbers
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        i += 2;
        while (i < n && isHexDigit(src[i])) i++;
      } else {
        while (i < n && isDigit(src[i])) i++;
        if (src[i] === ".") {
          i++;
          while (i < n && isDigit(src[i])) i++;
        }
        if (src[i] === "e" || src[i] === "E") {
          const save = i;
          let j = i + 1;
          if (src[j] === "+" || src[j] === "-") j++;
          if (isDigit(src[j] ?? "")) {
            i = j;
            while (i < n && isDigit(src[i])) i++;
          } else {
            i = save;
          }
        }
      }
      while (i < n && "uUfF".includes(src[i])) i++;
      out.push({ kind: "number", text: src.slice(start, i), spaceBefore });
      spaceBefore = false;
      continue;
    }
    // Identifiers
    if (isAlpha(c)) {
      const start = i;
      while (i < n && isAlnum(src[i])) i++;
      out.push({ kind: "ident", text: src.slice(start, i), spaceBefore });
      spaceBefore = false;
      continue;
    }
    // Punctuation (single char)
    out.push({ kind: "punct", text: c, spaceBefore });
    spaceBefore = false;
    i++;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Number shortening
// ---------------------------------------------------------------------------

/** Shortens a numeric literal without changing its value. */
export function shortenNumber(raw: string): string {
  let mantissa = raw;
  let suffix = "";
  while (mantissa.length > 0 && "uUfF".includes(mantissa[mantissa.length - 1])) {
    suffix = mantissa[mantissa.length - 1] + suffix;
    mantissa = mantissa.slice(0, -1);
  }

  if (mantissa.startsWith("0x") || mantissa.startsWith("0X")) {
    return raw; // never touch hex literals
  }

  let exponent = "";
  const eIdx = mantissa.search(/[eE]/);
  if (eIdx !== -1) {
    exponent = mantissa.slice(eIdx);
    mantissa = mantissa.slice(0, eIdx);
  }

  let result = mantissa;
  const dot = result.indexOf(".");
  if (dot !== -1) {
    let intPart = result.slice(0, dot);
    const fracPart = result.slice(dot + 1);
    const trimmedFrac = fracPart.replace(/0+$/, "");
    if (intPart === "0") intPart = "";
    // (bug fix) "0.0" -> both parts empty would otherwise produce a
    // bare "." which is not a valid GLSL float literal at all.
    if (intPart === "" && trimmedFrac === "") {
      result = "0.";
    } else {
      result = `${intPart}.${trimmedFrac}`;
    }
  }
  return `${result}${exponent}${suffix}`;
}

// ---------------------------------------------------------------------------
// Name generator: a, b, c, ... z, aa, ab, ...
// ---------------------------------------------------------------------------

function* nameGenerator(): Generator<string> {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_";
  const base = alphabet.length;
  let len = 1;
  for (;;) {
    const total = Math.pow(base, len);
    for (let counter = 0; counter < total; counter++) {
      let nn = counter;
      const chars: string[] = [];
      for (let k = 0; k < len; k++) {
        chars.push(alphabet[nn % base]);
        nn = Math.floor(nn / base);
      }
      chars.reverse();
      yield chars.join("");
    }
    len++;
  }
}

// ---------------------------------------------------------------------------
// Declaration discovery
// ---------------------------------------------------------------------------

/**
 * Returns the token-index span [open, close] of every `struct { ... }`
 * body (indices of the braces themselves) in the token stream.
 *
 * Needed because a struct's *members* are declared with the exact same
 * `<type> <ident>` shape as an ordinary local/global (`struct P{float
 * x;float y;};`) — but a member name isn't a bare identifier anywhere
 * else in the file the way a real variable is; it only ever appears
 * after a `.`, alongside every *other* use of that name as a swizzle
 * component (`somevec.x`) or an unrelated variable. Blanket-renaming it
 * would rename those too. See findRenamable, which uses this to
 * exclude member declarations from the renamable pool entirely rather
 * than attempt (much harder, and not attempted here) type-aware
 * tracking of which `.field` belongs to which struct.
 */
function structBodyRanges(tokens: Token[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < tokens.length) {
    const isStructKw = tokens[i].kind === "ident" && tokens[i].text === "struct";
    if (isStructKw) {
      let j = i + 1;
      while (j < tokens.length && !isPunct(tokens[j], "{") && !isPunct(tokens[j], ";")) j++;
      if (isPunct(tokens[j], "{")) {
        let depth = 0;
        let k = j;
        for (; k < tokens.length; k++) {
          if (isPunct(tokens[k], "{")) depth++;
          else if (isPunct(tokens[k], "}")) {
            depth--;
            if (depth === 0) {
              ranges.push([j, k]);
              break;
            }
          }
        }
        i = k;
        continue;
      }
    }
    i++;
  }
  return ranges;
}

function strictlyInsideAny(idx: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([open, close]) => idx > open && idx < close);
}

/** Extracts every identifier-shaped substring ([A-Za-z_][A-Za-z0-9_]*) from a raw text fragment. */
function identifiersInText(text: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[0]);
  return out;
}

/**
 * Every identifier-shaped word appearing on any #-directive line.
 *
 * #define bodies are kept as opaque, never-tokenized text — so if a
 * name referenced only inside a macro body (`#define GET_X(p) (p.x +
 * OFFSET)`) is also declared as an ordinary variable elsewhere (`float
 * OFFSET = 1.0;`), renaming that declaration desyncs it from the
 * macro: the preprocessor still expands OFFSET verbatim, now
 * referencing a name that no longer exists anywhere. findRenamable
 * uses this to exclude any such name from the renamable pool entirely.
 */
function preprocReferencedNames(tokens: Token[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.kind === "preproc") {
      for (const name of identifiersInText(t.text)) out.add(name);
    }
  }
  return out;
}

/**
 * Returns the token-index span of every top-level `{...}` block —
 * struct bodies, function bodies, interface blocks — found by scanning
 * for a `{` at brace-depth 0 and jumping straight to its match (so
 * anything nested inside is never independently visited as "top-level"
 * by this scan).
 */
function topLevelBraceRanges(tokens: Token[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < tokens.length) {
    if (isPunct(tokens[i], "{")) {
      let depth = 0;
      let k = i;
      for (; k < tokens.length; k++) {
        if (isPunct(tokens[k], "{")) depth++;
        else if (isPunct(tokens[k], "}")) {
          depth--;
          if (depth === 0) break;
        }
      }
      if (k < tokens.length) {
        ranges.push([i, k]);
        i = k + 1;
        continue;
      }
    }
    i++;
  }
  return ranges;
}

/**
 * If `bodyOpen` is a function body's opening `{` (i.e. the token right
 * before it closes a parameter list), returns the index of that
 * parameter list's own `(` — so the returned range covers parameters
 * too, not just the body. Function parameters are only visible inside
 * their own function, exactly like locals, and must be treated as such
 * for scope-aware renaming; returns `bodyOpen` unchanged if there's no
 * parameter list immediately before it.
 */
function extendLeftToParams(tokens: Token[], bodyOpen: number): number {
  if (bodyOpen === 0 || !isPunct(tokens[bodyOpen - 1], ")")) return bodyOpen;
  let depth = 0;
  let k = bodyOpen - 1;
  for (;;) {
    if (isPunct(tokens[k], ")")) depth++;
    else if (isPunct(tokens[k], "(")) {
      depth--;
      if (depth === 0) return k;
    }
    if (k === 0) break;
    k--;
  }
  return bodyOpen;
}

/**
 * The token-index span of every function body in the file (parameters
 * through the closing brace), used to scope-partition renaming: two
 * locals in two *different* function scopes never conflict, and can
 * safely be handed the same short name — see findRenamable and golf().
 * Struct bodies are excluded.
 */
function functionScopeRanges(tokens: Token[]): Array<[number, number]> {
  const structBodies = structBodyRanges(tokens);
  return topLevelBraceRanges(tokens)
    .filter(([open]) => !structBodies.some(([s]) => s === open))
    .map(([open, close]): [number, number] => [extendLeftToParams(tokens, open), close]);
}

/** Which independently-renamable scope a declaration belongs to — see `functionScopeRanges`. `null` means Global (visible everywhere). */
type Scope = number | null;

export interface RenamableDecl {
  name: string;
  scope: Scope;
}

/**
 * Scans for `<type> <ident>` declaration patterns and returns
 * identifiers safe and beneficial to rename, each tagged with the scope
 * it's declared in and ranked by usage frequency (frequency drives
 * assignment order across *all* scopes together — see golf()). Struct
 * member declarations are deliberately excluded (see structBodyRanges)
 * — the struct's own type name, declared just before the `{`, is
 * unaffected.
 */
function findRenamable(tokens: Token[]): RenamableDecl[] {
  const freq = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  const structBodies = structBodyRanges(tokens);
  const preprocNames = preprocReferencedNames(tokens);
  const functionScopes = functionScopeRanges(tokens);
  // Every scope a name's declaration pattern matched in. More than one
  // distinct scope (or a global alongside any local) means we can't
  // tell which use belongs to which declaration site, so it's treated
  // as Global — the always-safe fallback.
  const scopesSeen = new Map<string, Set<Scope>>();

  tokens.forEach((t, idx) => {
    if (t.kind === "ident") {
      freq.set(t.text, (freq.get(t.text) ?? 0) + 1);
      if (!firstSeen.has(t.text)) firstSeen.set(t.text, idx);
    }
  });

  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a.kind !== "ident" || b.kind !== "ident") continue;
    const aIsType = DECLARATION_INTRODUCERS.has(a.text);
    const bIsUser =
      !KEYWORDS.has(b.text) &&
      !BUILTIN_FUNCTIONS.has(b.text) &&
      !BUILTIN_VARIABLES.has(b.text) &&
      !PROTECTED_HOST_NAMES.has(b.text);
    if (aIsType && bIsUser && !strictlyInsideAny(i + 1, structBodies) && !preprocNames.has(b.text)) {
      const fnIdx = functionScopes.findIndex(([s, e]) => i + 1 > s && i + 1 < e);
      const tag: Scope = fnIdx === -1 ? null : fnIdx;
      if (!scopesSeen.has(b.text)) scopesSeen.set(b.text, new Set());
      scopesSeen.get(b.text)!.add(tag);
    }
  }

  const list: RenamableDecl[] = Array.from(scopesSeen.entries()).map(([name, tags]) => {
    const scope: Scope = tags.size === 1 ? Array.from(tags)[0] : null;
    return { name, scope };
  });

  // Most-frequently used identifiers get the shortest names, across
  // every scope together.
  list.sort((x, y) => {
    const fx = freq.get(x.name) ?? 0;
    const fy = freq.get(y.name) ?? 0;
    if (fy !== fx) return fy - fx;
    return (firstSeen.get(x.name) ?? 0) - (firstSeen.get(y.name) ?? 0);
  });
  return list;
}

// ---------------------------------------------------------------------------
// Aggressive golf passes (optional, structural — see ROADMAP.md)
//
// Unlike the passes above (which only ever change spelling), these
// rewrite statement shape. Each is scoped tightly enough to be provably
// value-preserving rather than "usually fine" — see the comment on each
// function for exactly what it declines to touch and why. They operate
// on the token stream *after* renaming/number-shortening, so `text`
// already holds the rendered (golfed) spelling; comparing `.text` for
// "is this the same identifier" is valid because renaming is a
// consistent 1:1 mapping.
// ---------------------------------------------------------------------------

export interface AggressiveStats {
  compoundAssignments: number;
  declarationsMerged: number;
  bracesRemoved: number;
  constantsFolded: number;
  deadLocalsRemoved: number;
  deadStoresRemoved: number;
  constantVectorsReduced: number;
  trailingVoidReturnsRemoved: number;
}

function newAggressiveStats(): AggressiveStats {
  return {
    compoundAssignments: 0,
    declarationsMerged: 0,
    bracesRemoved: 0,
    constantsFolded: 0,
    deadLocalsRemoved: 0,
    deadStoresRemoved: 0,
    constantVectorsReduced: 0,
    trailingVoidReturnsRemoved: 0,
  };
}

function isPunct(t: Token | undefined, c: string): boolean {
  return !!t && t.kind === "punct" && t.text === c;
}

const UNARY_PREFIX = new Set(["-", "+", "!", "~"]);

/**
 * Consumes one balanced bracket group starting at `open`, which must
 * point *at* the opening bracket (checked — returns -1 immediately
 * otherwise, so callers don't need a separate precondition check), and
 * returns the index just past the matching close, or -1 if unbalanced.
 */
function skipBalanced(items: Token[], open: number, openC: string, closeC: string): number {
  if (!isPunct(items[open], openC)) return -1;
  let depth = 0;
  let i = open;
  for (;;) {
    const t = items[i];
    if (!t) return -1;
    if (t.kind === "punct" && t.text === openC) depth++;
    else if (t.kind === "punct" && t.text === closeC) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
}

/**
 * Consumes exactly one primary expression (identifier/number, optional
 * unary prefixes, optional postfix chain of `.member`/`[index]`/`(call)`)
 * and returns the index just past it, or -1 if what follows isn't a
 * single self-contained term (e.g. a bare top-level operator, meaning
 * there's more than one term — see compoundAssignments()).
 */
function scanPrimary(items: Token[], start: number): number {
  let i = start;
  while (items[i] && items[i].kind === "punct" && UNARY_PREFIX.has(items[i].text)) i++;
  const head = items[i];
  if (!head) return -1;
  if (head.kind === "ident" || head.kind === "number") {
    i++;
  } else if (head.kind === "punct" && head.text === "(") {
    i = skipBalanced(items, i, "(", ")");
    if (i === -1) return -1;
  } else {
    return -1;
  }
  for (;;) {
    const t = items[i];
    if (!t) break;
    if (t.kind === "punct" && t.text === ".") {
      const next = items[i + 1];
      if (next && next.kind === "ident") i += 2;
      else return -1;
    } else if (t.kind === "punct" && t.text === "[") {
      i = skipBalanced(items, i, "[", "]");
      if (i === -1) return -1;
    } else if (t.kind === "punct" && t.text === "(") {
      i = skipBalanced(items, i, "(", ")");
      if (i === -1) return -1;
    } else {
      break;
    }
  }
  return i;
}

// ---------------------------------------------------------------------------
// Constant folding — restricted to plain (unsuffixed, non-hex) integer
// literals combined with *, / or %.
//
// This is deliberately much narrower than "fold any constant
// expression": float folding is skipped entirely because GLSL floats
// may run in mediump (or even lower) precision on the GPU, and a value
// computed host-side in full precision and printed back as a decimal
// literal is not guaranteed to re-round to the same bits the GPU would
// have produced evaluating the original expression itself — a real,
// silent correctness risk for no benefit worth taking. Integers have no
// such problem (GLSL int is exact 32-bit two's complement).
//
// +/- are also skipped: unlike */ /% (already the tightest arithmetic
// precedence in GLSL, so folding them can never change how an
// expression groups), folding a +/- pair would require checking that
// neither neighbour is a */ /% about to claim one of the operands first
// (2+3*4 is 2+(3*4), not (2+3)*4) — a precedence analysis this pass
// doesn't do, so it declines rather than risk it.
// ---------------------------------------------------------------------------

const FOLDABLE_OPS = new Set(["*", "/", "%"]);

/**
 * Parses `raw` as a plain base-10 integer literal (no hex prefix, no
 * decimal point/exponent, no u/f type suffix) — anything else returns
 * null so the caller leaves it untouched.
 */
function parsePlainInt(raw: string): number | null {
  if (raw.length === 0 || raw.startsWith("0x") || raw.startsWith("0X")) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

/**
 * Evaluates `a <op> b` with GLSL int (32-bit signed, truncating
 * division) semantics, returning null on overflow or division/modulo
 * by zero rather than guess at what the shader compiler would do —
 * declining to fold is always safe, folding to the wrong value
 * silently isn't.
 */
function foldIntOp(a: number, op: string, b: number): number | null {
  let result: number;
  if (op === "*") {
    result = a * b;
  } else if (op === "/") {
    if (b === 0 || (a === I32_MIN && b === -1)) return null;
    result = Math.trunc(a / b); // matches GLSL's truncation toward zero
  } else if (op === "%") {
    if (b === 0) return null;
    result = a % b; // JS % already truncates toward zero, matching GLSL
  } else {
    return null;
  }
  if (!Number.isSafeInteger(result) || result < I32_MIN || result > I32_MAX) return null;
  return result;
}

/**
 * Folds `<int> <op> <int>` into a single literal wherever the two
 * numbers are directly adjacent to the operator in the token stream —
 * which, since numeric literals are themselves primary expressions, is
 * exactly the condition under which they're guaranteed to be combined
 * by that operator in the parsed expression regardless of anything else
 * around them. Re-checks the freshly folded literal against what
 * follows so a chain like 2*3*4 folds all the way to 24 in one pass
 * (*, /, % are left-associative, so folding greedily left-to-right
 * matches GLSL's own evaluation order).
 */
function foldConstants(items: Token[], stats: AggressiveStats): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < items.length) {
    const lastOut = out[out.length - 1];
    const left = lastOut && lastOut.kind === "number" ? parsePlainInt(lastOut.text) : null;
    const opTok = items[i];
    const op = left !== null && opTok && opTok.kind === "punct" && FOLDABLE_OPS.has(opTok.text) ? opTok.text : null;
    const rightTok = items[i + 1];
    const right = op !== null && rightTok && rightTok.kind === "number" ? parsePlainInt(rightTok.text) : null;

    if (left !== null && op !== null && right !== null) {
      const value = foldIntOp(left, op, right);
      if (value !== null) {
        out.pop();
        const text = String(value);
        out.push({ kind: "number", text, spaceBefore: false });
        stats.constantsFolded++;
        i += 2;
        continue;
      }
    }

    out.push(items[i]);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constant vector reduction — `vec3(1.,1.,1.)` -> `vec3(1.)`. Safe by the
// GLSL spec itself, not a heuristic: a vector constructor called with a
// single scalar argument broadcasts that value to every component, which
// is *by definition* the same value the N-argument form produces when all
// N arguments are identical. Restricted to vec2/vec3/vec4 with plain
// numeric-literal arguments (never an expression) so this is a pure
// token-count-and-text-equality check — mirrors
// `rust-core/src/aggressive.rs::reduce_constant_vectors` exactly,
// including *not* handling negative literals (`-1.` tokenizes as a
// separate `-` punct, not part of the number token).
// ---------------------------------------------------------------------------

const VEC_ARITY: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4 };

/** If `items[i..]` is `vecN(<lit>,...,<lit>)` with exactly N identical numeric-literal arguments, returns the closing `)` index and the index of the literal to keep. */
function matchConstantVector(items: Token[], i: number): [number, number] | null {
  const head = items[i];
  if (!head || head.kind !== "ident") return null;
  const arity = VEC_ARITY[head.text];
  if (!arity) return null;
  const openParen = items[i + 1];
  if (!openParen || openParen.kind !== "punct" || openParen.text !== "(") return null;

  let idx = i + 2;
  let firstText: string | null = null;
  let firstIdx = -1;
  for (let k = 0; k < arity; k++) {
    const tok = items[idx];
    if (!tok || tok.kind !== "number") return null;
    if (firstText === null) {
      firstText = tok.text;
      firstIdx = idx;
    } else if (tok.text !== firstText) {
      return null;
    }
    idx++;
    if (k + 1 < arity) {
      const comma = items[idx];
      if (!comma || comma.kind !== "punct" || comma.text !== ",") return null;
      idx++;
    }
  }
  const close = items[idx];
  if (!close || close.kind !== "punct" || close.text !== ")") return null;
  return [idx, firstIdx];
}

function reduceConstantVectors(items: Token[], stats: AggressiveStats): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < items.length) {
    const match = matchConstantVector(items, i);
    if (match) {
      const [closeIdx, valueIdx] = match;
      out.push(items[i]);
      out.push(items[i + 1]);
      out.push(items[valueIdx]);
      out.push(items[closeIdx]);
      stats.constantVectorsReduced++;
      i = closeIdx + 1;
      continue;
    }
    out.push(items[i]);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trailing void-return elision — mirrors
// `rust-core/src/aggressive.rs::strip_trailing_void_return` exactly,
// including the `if(x)return;` trap guard (see that file's comment for
// the full reasoning): only strips a bare `return;` that is both (a)
// immediately preceded by a statement/block boundary (`;`, `{`, `}`, or
// start of file — never e.g. `)` from an unbraced `if(x)`) and (b)
// immediately followed by the closing `}` of the `void` function itself.
// ---------------------------------------------------------------------------

function voidFunctionBodyClosers(items: Token[]): Set<number> {
  const closers = new Set<number>();
  let i = 0;
  while (i < items.length) {
    const isVoid = items[i]?.kind === "ident" && items[i].text === "void";
    if (isVoid && items[i + 1]?.kind === "ident" && isPunct(items[i + 2], "(")) {
      let depth = 0;
      let k = i + 2;
      while (k < items.length) {
        if (isPunct(items[k], "(")) depth++;
        else if (isPunct(items[k], ")")) {
          depth--;
          if (depth === 0) break;
        }
        k++;
      }
      if (isPunct(items[k + 1], "{")) {
        let bd = 0;
        let m = k + 1;
        while (m < items.length) {
          if (isPunct(items[m], "{")) bd++;
          else if (isPunct(items[m], "}")) {
            bd--;
            if (bd === 0) {
              closers.add(m);
              break;
            }
          }
          m++;
        }
        i = m;
        continue;
      }
    }
    i++;
  }
  return closers;
}

function isStatementBoundary(items: Token[], idx: number): boolean {
  if (idx === 0) return true;
  const prev = items[idx - 1];
  return isPunct(prev, ";") || isPunct(prev, "{") || isPunct(prev, "}");
}

function stripTrailingVoidReturn(items: Token[], stats: AggressiveStats): Token[] {
  const closers = voidFunctionBodyClosers(items);
  const out: Token[] = [];
  let i = 0;
  while (i < items.length) {
    const isReturn = items[i]?.kind === "ident" && items[i].text === "return";
    if (isReturn && isStatementBoundary(items, i) && isPunct(items[i + 1], ";") && closers.has(i + 2)) {
      stats.trailingVoidReturnsRemoved++;
      i += 2;
      continue;
    }
    out.push(items[i]);
    i++;
  }
  return out;
}

const STATEMENT_TERMINATORS = new Set([";", ",", ")", "]", "}"]);

function isTerminator(items: Token[], idx: number): boolean {
  const t = items[idx];
  if (!t) return true; // end of file also ends a statement
  return t.kind === "punct" && STATEMENT_TERMINATORS.has(t.text);
}

const COMPOUND_OPS = new Set(["+", "-", "*", "/", "%"]);

/**
 * Rewrites `a = a <op> <single term>;` into `a <op>= <single term>;`.
 * Only fires when the RHS is exactly one primary expression — never a
 * longer chain — because that's the only case where wrapping it in the
 * implicit parentheses of a compound assignment can never change the
 * result (`a - (term)` === `a - term` always; but `a - b - c` !==
 * `a -= (b - c)`, so longer chains are deliberately left alone).
 */
function compoundAssignments(items: Token[], stats: AggressiveStats): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < items.length) {
    const a = items[i];
    const eq = items[i + 1];
    const a2 = items[i + 2];
    const opTok = items[i + 3];
    const matches =
      a && a.kind === "ident" &&
      isPunct(eq, "=") &&
      a2 && a2.kind === "ident" && a2.text === a.text &&
      opTok && opTok.kind === "punct" && COMPOUND_OPS.has(opTok.text);

    if (matches) {
      const prev = items[i - 1];
      const isDeclarator = i > 0 && !!prev && prev.kind === "ident" && TYPE_KEYWORDS.has(prev.text);
      if (!isDeclarator) {
        const end = scanPrimary(items, i + 4);
        if (end !== -1 && isTerminator(items, end)) {
          out.push(a);
          out.push({ kind: "punct", text: opTok.text, spaceBefore: false });
          out.push({ kind: "punct", text: "=", spaceBefore: false });
          for (let k = i + 4; k < end; k++) out.push(items[k]);
          stats.compoundAssignments++;
          i = end;
          continue;
        }
      }
    }

    out.push(items[i]);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dead local elimination — deliberately the narrowest possible slice of
// "dead code elimination": drops a local declaration only when the
// declared name appears *nowhere else at all* in the file (so it's
// never read, never reassigned — there is nothing to preserve), and its
// initializer (if any) is a single identifier or number literal with no
// function call, member access, or side effect of any kind.
//
// A real "eliminate variables that are written but never read" pass
// would need genuine data-flow analysis — reassignments, branches,
// loops, out/inout parameters aliasing the variable, and function calls
// that might have side effects all have to be accounted for correctly,
// or the pass deletes code that mattered. This narrower version
// sidesteps all of that: a name used exactly once, at its own
// declaration, with a side-effect-free initializer, can never be
// observed regardless of control flow, so removing it is safe by
// construction rather than by careful-but-fallible analysis.
// ---------------------------------------------------------------------------

function isBareOperand(items: Token[], idx: number): boolean {
  const t = items[idx];
  return !!t && (t.kind === "ident" || t.kind === "number");
}

/**
 * If the declaration statement starting at `start` is a plain local (no
 * qualifier — TYPE_KEYWORDS excludes uniform/const/etc, so only
 * unqualified locals ever match) whose name occurs exactly once in the
 * whole file and whose initializer, if any, is a single bare identifier
 * or number literal (never a function call — `foo(x)` fails because the
 * token right after the bare `foo` operand would have to be `;` and
 * it's `(` instead), returns the index just past its terminating `;` so
 * the caller can drop the whole statement. Returns -1 for anything else
 * (array declarators, multi-token initializers, names used elsewhere,
 * ...) — decline rather than risk removing something that matters.
 */
function tryRemoveDeadDecl(items: Token[], start: number, freq: Map<string, number>): number {
  const t = findIdent(items, start);
  if (t === null || !TYPE_KEYWORDS.has(t)) return -1;
  const name = findIdent(items, start + 1);
  if (name === null || (freq.get(name) ?? 0) !== 1) return -1;

  const after = items[start + 2];
  if (isPunct(after, ";")) return start + 3;
  if (isPunct(after, "=")) {
    let i = start + 3;
    const prefixTok = items[i];
    if (prefixTok && prefixTok.kind === "punct" && UNARY_PREFIX.has(prefixTok.text)) i++;
    if (!isBareOperand(items, i)) return -1;
    i++;
    return isPunct(items[i], ";") ? i + 1 : -1;
  }
  return -1;
}

/**
 * Drops dead local declarations wherever tryRemoveDeadDecl finds one at
 * a statement boundary (right after `;`, `{`, `}`, or file start — the
 * same boundary test mergeDeclarations uses, which already correctly
 * excludes a for(...) header's own declaration: the token right before
 * it is `(`, never a boundary marker).
 */
function eliminateDeadLocals(items: Token[], stats: AggressiveStats): Token[] {
  const freq = new Map<string, number>();
  for (const t of items) {
    if (t.kind === "ident") freq.set(t.text, (freq.get(t.text) ?? 0) + 1);
  }

  const out: Token[] = [];
  let i = 0;
  while (i < items.length) {
    const last = out[out.length - 1];
    const atBoundary = !last || (last.kind === "punct" && (last.text === ";" || last.text === "{" || last.text === "}"));

    if (atBoundary) {
      const end = tryRemoveDeadDecl(items, i, freq);
      if (end !== -1) {
        stats.deadLocalsRemoved++;
        i = end;
        continue;
      }
    }

    out.push(items[i]);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dead store elimination — a second, complementary slice of "dead code
// elimination", distinct from eliminateDeadLocals above: that one
// handles a variable that's declared and *never referenced again at
// all*; this one handles a variable that's written, then **immediately**
// overwritten by the very next statement with no read in between —
// `float x=1.;x=2.;` — where the first write is dead even though x
// itself is very much still used later.
//
// Scope is deliberately narrow: only *directly adjacent* statement
// pairs are considered, at bracket/paren depth 0 (so a for-header's own
// `int i=0;` clause is never mistaken for a real statement — see the
// depth tracking below). A dead store separated from its superseding
// write by any other statement, or by a branch/loop, is not caught —
// proving liveness across control flow needs real data-flow analysis,
// which this intentionally doesn't attempt. Catching only
// immediately-adjacent pairs sidesteps that entirely: there is no other
// code path between the two statements for the first write's value to
// have been observed on, so overwriting it is safe *by construction*,
// not by reasoning about control flow.
// ---------------------------------------------------------------------------

interface SimpleWrite {
  isDecl: boolean;
  name: string;
  /** The identifier the RHS reads, if the RHS is a (possibly unary-prefixed) bare identifier — see eliminateDeadStores. */
  rhsIdent: string | null;
  start: number;
  end: number;
}

/**
 * Parses `[<type>] <ident> = <bare operand>;` starting at `start` — a
 * plain assignment or a declaration with a trivial initializer. Returns
 * null for anything else (compound RHS, function calls, compound-
 * assignment operators, array/member targets, ...): those are always
 * left alone rather than risk reasoning incorrectly about them.
 */
function parseSimpleWrite(items: Token[], start: number): SimpleWrite | null {
  let i = start;
  const isDecl = items[i] && items[i].kind === "ident" && TYPE_KEYWORDS.has(items[i].text);
  if (isDecl) i++;
  const nameTok = items[i];
  if (!nameTok || nameTok.kind !== "ident") return null;
  const name = nameTok.text;
  i++;
  if (!isPunct(items[i], "=")) return null;
  i++;
  if (items[i] && items[i].kind === "punct" && UNARY_PREFIX.has(items[i].text)) i++;
  const operand = items[i];
  let rhsIdent: string | null;
  if (operand && operand.kind === "ident") rhsIdent = operand.text;
  else if (operand && operand.kind === "number") rhsIdent = null;
  else return null;
  i++;
  if (!isPunct(items[i], ";")) return null;
  return { isDecl: !!isDecl, name, rhsIdent, start, end: i + 1 };
}

/**
 * Drops a simple write when the *very next* statement is a plain
 * (non-declaring) simple write to the same name that doesn't itself
 * read that name — see the module docs above. A declaration's write is
 * reduced to a bare `<type> <ident>;` rather than dropped outright (its
 * declaration must survive; only the wasted initial value dies).
 */
function eliminateDeadStores(items: Token[], stats: AggressiveStats): Token[] {
  const out: Token[] = [];
  let i = 0;
  // Only ever matched at paren/bracket depth 0, so a for-header's own
  // `int i=0;i<9;i++` (or any other expression-context `;`) is never
  // mistaken for a real statement boundary — those live at depth > 0
  // from the moment their enclosing `(` is seen.
  let depth = 0;
  while (i < items.length) {
    if (depth === 0) {
      const write = parseSimpleWrite(items, i);
      if (write) {
        const next = parseSimpleWrite(items, write.end);
        if (next && !next.isDecl && next.name === write.name && next.rhsIdent !== write.name) {
          stats.deadStoresRemoved++;
          if (write.isDecl) {
            out.push(items[write.start]);
            out.push(items[write.start + 1]);
            out.push({ kind: "punct", text: ";", spaceBefore: false });
          }
          i = write.end;
          continue;
        }
      }
    }
    if (isPunct(items[i], "(") || isPunct(items[i], "[")) depth++;
    else if (isPunct(items[i], ")") || isPunct(items[i], "]")) depth--;
    out.push(items[i]);
    i++;
  }
  return out;
}

/**
 * Merges adjacent declaration statements of the identical type keyword:
 * `float a=1.;float b=2.;` -> `float a=1.,b=2.;`. Only fires when the
 * second statement starts with the exact same type keyword as the one
 * currently open, immediately followed by a declarator identifier — in
 * GLSL a bare `type identifier` pair at statement position is
 * unambiguously a declaration (constructor calls like `vec3(...)` are
 * always followed by `(`, never a bare name). Tracking resets on any
 * statement that isn't itself a fresh same-type declaration, so
 * unrelated statements in between are never bridged.
 */
function mergeDeclarations(items: Token[], stats: AggressiveStats): Token[] {
  const out: Token[] = [];
  let pendingType: string | null = null;
  let i = 0;

  while (i < items.length) {
    const last = out[out.length - 1];
    const atBoundary = !last || (last.kind === "punct" && (last.text === ";" || last.text === "{" || last.text === "}"));

    if (atBoundary) {
      const t = items[i];
      const declName = items[i + 1];
      const declStart = t && t.kind === "ident" && TYPE_KEYWORDS.has(t.text) && declName && declName.kind === "ident" ? t.text : null;

      if (declStart) {
        const canMerge = pendingType === declStart && !!last && isPunct(last, ";");
        if (canMerge) {
          out.pop();
          out.push({ kind: "punct", text: ",", spaceBefore: false });
          stats.declarationsMerged++;
          i++;
          continue;
        }
        pendingType = declStart;
        out.push(items[i]);
        i++;
        continue;
      } else {
        pendingType = null;
      }
    }

    out.push(items[i]);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Redundant-brace removal (`if(x){y=1;}` -> `if(x)y=1;`)
//
// GLSL, like C, makes the braces around the body of if/else/for/while
// optional when that body is a single statement. Removing them is *the*
// classic shader-golfing move — but doing it wrong produces the
// textbook "dangling else" bug: `if(a){if(b)x;}else y;` means "else
// belongs to a", but naively stripping both pairs of braces gives
// `if(a)if(b)x;else y;`, where else now binds to the *nearest* if (b)
// instead — a silent behaviour change, not a syntax error.
//
// This is a small recursive-descent statement scanner (scanStatement)
// plus a rewriter (rewriteBody/rewriteSequence) that only strips a
// block's braces when doing so cannot change which if a later else
// binds to (isHungry) and the block's single statement isn't a
// declaration (declarations are never valid as the brace-less body of
// if/for/while, even though expression statements, return, break,
// continue and discard all are).
// ---------------------------------------------------------------------------

function findIdent(items: Token[], i: number): string | null {
  const t = items[i];
  return t && t.kind === "ident" ? t.text : null;
}

/**
 * Consumes exactly one GLSL statement starting at `start` and returns
 * the index just past it, or -1 if what follows doesn't parse as a
 * single well-formed statement — used both to find statement boundaries
 * and (by returning -1 on constructs we don't model, like `switch`) to
 * make the whole pass decline gracefully rather than guess on shapes it
 * doesn't understand.
 */
function scanStatement(items: Token[], start: number): number {
  const kw = findIdent(items, start);
  if (kw === "if") {
    const parenEnd = skipBalanced(items, start + 1, "(", ")");
    if (parenEnd === -1) return -1;
    const thenEnd = scanStatement(items, parenEnd);
    if (thenEnd === -1) return -1;
    if (findIdent(items, thenEnd) === "else") return scanStatement(items, thenEnd + 1);
    return thenEnd;
  }
  if (kw === "for" || kw === "while") {
    const parenEnd = skipBalanced(items, start + 1, "(", ")");
    if (parenEnd === -1) return -1;
    return scanStatement(items, parenEnd);
  }
  if (kw === "do") {
    const bodyEnd = scanStatement(items, start + 1);
    if (bodyEnd === -1 || findIdent(items, bodyEnd) !== "while") return -1;
    const parenEnd = skipBalanced(items, bodyEnd + 1, "(", ")");
    if (parenEnd === -1) return -1;
    return isPunct(items[parenEnd], ";") ? parenEnd + 1 : -1;
  }
  const t = items[start];
  if (!t) return -1;
  if (t.kind === "punct" && t.text === "{") return skipBalanced(items, start, "{", "}");
  if (t.kind === "punct" && t.text === ";") return start + 1;
  // Expression statement, declaration, return/break/continue/discard, or
  // an empty `;` — all share the same shape here: consume tokens
  // (tracking paren/bracket depth so a `;` inside e.g. a for(...) header
  // never counts) up to the next top-level `;`. Hitting an unexpected
  // `{`/`}` at depth 0 means this is some construct we don't model (a
  // switch body, an interface block, ...) — bail rather than mis-scan it.
  let i = start;
  let depth = 0;
  for (;;) {
    const cur = items[i];
    if (!cur) return -1;
    if (cur.kind === "punct" && (cur.text === "(" || cur.text === "[")) depth++;
    else if (cur.kind === "punct" && (cur.text === ")" || cur.text === "]")) depth--;
    else if (cur.kind === "punct" && (cur.text === "{" || cur.text === "}")) return -1;
    else if (cur.kind === "punct" && cur.text === ";" && depth === 0) return i + 1;
    i++;
  }
}

/**
 * True if the statement at `start` still has an "open" (else-less) if
 * as its rightmost branch — i.e. a trailing else placed immediately
 * after this statement would bind to *that* inner if rather than
 * passing through to whatever encloses this statement. A `{...}` block
 * is never hungry (its braces already resolve any ambiguity inside
 * them); for/while propagate their body's hunger (an else-less if as a
 * bare loop body can still steal a trailing else).
 */
function isHungry(items: Token[], start: number): boolean {
  const kw = findIdent(items, start);
  if (kw === "if") {
    const parenEnd = skipBalanced(items, start + 1, "(", ")");
    if (parenEnd === -1) return false;
    const thenEnd = scanStatement(items, parenEnd);
    if (thenEnd === -1) return false;
    if (findIdent(items, thenEnd) === "else") return isHungry(items, thenEnd + 1);
    return true;
  }
  if (kw === "for" || kw === "while") {
    const parenEnd = skipBalanced(items, start + 1, "(", ")");
    return parenEnd === -1 ? false : isHungry(items, parenEnd);
  }
  return false;
}

/**
 * A declaration (`float x=1.;`, `const int n=3;`, ...) is never valid
 * GLSL as the brace-less body of if/for/while — only a genuine
 * statement (expression, jump, block, nested control-flow, or empty
 * `;`) is. TYPE_KEYWORDS covers the ordinary case; const and the
 * precision qualifiers are checked separately since they're valid
 * declaration prefixes but aren't in that set (which only names types).
 */
function looksLikeDeclaration(items: Token[], start: number): boolean {
  const a = items[start];
  const b = items[start + 1];
  if (!a || a.kind !== "ident" || !b || b.kind !== "ident") return false;
  return TYPE_KEYWORDS.has(a.text) || a.text === "const" || a.text === "highp" || a.text === "mediump" || a.text === "lowp";
}

/**
 * Rewrites the statement at a "body position" — the then-branch,
 * else-branch, or for/while body spanning [bodyStart, bodyEnd) —
 * stripping its braces when it holds exactly one statement and doing
 * so is safe (see module docs). `hasTrailingElse` is whether this body
 * is immediately followed by an else that could be misattributed if the
 * body turns out to be hungry once unwrapped. Returns null if the
 * region couldn't be parsed.
 */
function rewriteControlBody(
  items: Token[],
  bodyStart: number,
  bodyEnd: number,
  hasTrailingElse: boolean,
  stats: AggressiveStats,
): Token[] | null {
  if (isPunct(items[bodyStart], "{")) {
    const innerStart = bodyStart + 1;
    const innerEnd = bodyEnd - 1; // bodyEnd is just past the matching '}'
    const single = innerStart < innerEnd && scanStatement(items, innerStart) === innerEnd;
    if (single) {
      const isDecl = looksLikeDeclaration(items, innerStart);
      const unsafeHungry = hasTrailingElse && isHungry(items, innerStart);
      if (!isDecl && !unsafeHungry) {
        stats.bracesRemoved++;
        const rewritten = rewriteBody(items, innerStart, stats);
        return rewritten ? rewritten[0] : null;
      }
    }
    // Multiple statements, or unsafe/declaration — keep these braces,
    // but still recurse into the contents: a nested if/for/while
    // further inside may still have its own (independently safe)
    // braces to strip.
    const out = [items[bodyStart]];
    out.push(...rewriteSequence(items, innerStart, innerEnd, stats));
    out.push(items[innerEnd]);
    return out;
  }
  // Already brace-less in the source — still recurse in case it's
  // itself a nested control statement with strippable braces.
  const rewritten = rewriteBody(items, bodyStart, stats);
  return rewritten ? rewritten[0] : null;
}

/**
 * Rewrites exactly one statement starting at `start`, recursing into
 * if/for/while/do/block structure to strip nested redundant braces
 * wherever it's safe to. Returns the rewritten tokens plus the end
 * index in the *original* stream, or null if unparseable.
 */
function rewriteBody(items: Token[], start: number, stats: AggressiveStats): [Token[], number] | null {
  const kw = findIdent(items, start);
  if (kw === "if") {
    const out: Token[] = [items[start]];
    const parenEnd = skipBalanced(items, start + 1, "(", ")");
    if (parenEnd === -1) return null;
    out.push(...items.slice(start + 1, parenEnd));
    const thenEnd = scanStatement(items, parenEnd);
    if (thenEnd === -1) return null;
    const hasElse = findIdent(items, thenEnd) === "else";
    const thenBody = rewriteControlBody(items, parenEnd, thenEnd, hasElse, stats);
    if (!thenBody) return null;
    out.push(...thenBody);
    let i = thenEnd;
    if (hasElse) {
      out.push(items[i]);
      const elseStart = i + 1;
      const elseEnd = scanStatement(items, elseStart);
      if (elseEnd === -1) return null;
      const elseBody = rewriteControlBody(items, elseStart, elseEnd, false, stats);
      if (!elseBody) return null;
      out.push(...elseBody);
      i = elseEnd;
    }
    return [out, i];
  }
  if (kw === "for" || kw === "while") {
    const out: Token[] = [items[start]];
    const parenEnd = skipBalanced(items, start + 1, "(", ")");
    if (parenEnd === -1) return null;
    out.push(...items.slice(start + 1, parenEnd));
    const bodyEnd = scanStatement(items, parenEnd);
    if (bodyEnd === -1) return null;
    const body = rewriteControlBody(items, parenEnd, bodyEnd, false, stats);
    if (!body) return null;
    out.push(...body);
    return [out, bodyEnd];
  }
  if (kw === "do") {
    const out: Token[] = [items[start]];
    const bodyEnd = scanStatement(items, start + 1);
    if (bodyEnd === -1) return null;
    const body = rewriteControlBody(items, start + 1, bodyEnd, false, stats);
    if (!body) return null;
    out.push(...body);
    let i = bodyEnd;
    if (findIdent(items, i) !== "while") return null;
    out.push(items[i]);
    const parenEnd = skipBalanced(items, i + 1, "(", ")");
    if (parenEnd === -1) return null;
    out.push(...items.slice(i + 1, parenEnd));
    i = parenEnd;
    if (!isPunct(items[i], ";")) return null;
    out.push(items[i]);
    return [out, i + 1];
  }
  if (isPunct(items[start], "{")) {
    const close = skipBalanced(items, start, "{", "}");
    if (close === -1) return null;
    const out: Token[] = [items[start]];
    out.push(...rewriteSequence(items, start + 1, close - 1, stats));
    out.push(items[close - 1]);
    return [out, close];
  }
  const end = scanStatement(items, start);
  if (end === -1) return null;
  return [items.slice(start, end), end];
}

/**
 * Rewrites a sequence of statements spanning [start, end) (the contents
 * of a block), one statement at a time. If a statement can't be parsed
 * (an unmodelled construct like switch), copies the remainder of the
 * range through unchanged rather than risk mangling something it
 * doesn't understand — declining to golf is always safe, guessing isn't.
 */
function rewriteSequence(items: Token[], start: number, end: number, stats: AggressiveStats): Token[] {
  const out: Token[] = [];
  let i = start;
  while (i < end) {
    const result = rewriteBody(items, i, stats);
    if (result && result[1] > i && result[1] <= end) {
      out.push(...result[0]);
      i = result[1];
    } else {
      out.push(...items.slice(i, end));
      break;
    }
  }
  return out;
}

/**
 * Entry point: finds each top-level `{...}` block in the token stream
 * (a function body, struct body, interface block, ...) and rewrites its
 * contents as a statement sequence. Everything outside any braces
 * (return types, function signatures, global declarations, #define/
 * #version lines) is copied through untouched.
 */
function stripRedundantBraces(items: Token[], stats: AggressiveStats): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < items.length) {
    if (isPunct(items[i], "{")) {
      const close = skipBalanced(items, i, "{", "}");
      if (close !== -1) {
        out.push(items[i]);
        out.push(...rewriteSequence(items, i + 1, close - 1, stats));
        out.push(items[close - 1]);
        i = close;
        continue;
      }
    }
    out.push(items[i]);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout (re-joining tokens with the minimum safe whitespace)
// ---------------------------------------------------------------------------

const AMBIGUOUS_PAIRS = new Set([
  "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=",
  "*=", "/=", "%=", "&=", "|=", "^=", "//", "/*",
]);

function isWordLike(t: Token): boolean {
  return t.kind === "ident" || t.kind === "number";
}

function layout(items: Token[]): string {
  let out = "";
  let prevWordLike = false;

  for (let i = 0; i < items.length; i++) {
    const tok = items[i];
    const piece = tok.text;

    if (tok.kind === "preproc") {
      if (out.length > 0 && !out.endsWith("\n")) out += "\n";
      out += tok.text + "\n";
      prevWordLike = false;
      continue;
    }

    const curWordLike = isWordLike(tok);
    let needSpace = prevWordLike && curWordLike;

    if (!needSpace && i > 0 && out.length > 0) {
      const prevTok = items[i - 1];
      if (prevTok.kind === "punct" && tok.kind === "punct") {
        const pair = out[out.length - 1] + (piece[0] ?? "");
        // (bug fix) "x - -y" must not collapse into "x--y" — only
        // safe to omit the space if the source had these two
        // characters already adjacent (i.e. it already meant the
        // compound operator, or golfing hasn't changed adjacency).
        if (tok.spaceBefore && AMBIGUOUS_PAIRS.has(pair)) {
          needSpace = true;
        }
      }
    }

    if (needSpace) out += " ";
    out += piece;
    prevWordLike = curWordLike;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GolfStats {
  inputChars: number;
  outputChars: number;
  reductionPct: number;
  renamedCount: number;
  numbersShortened: number;
  aggressive: AggressiveStats;
}

export interface GolfResult {
  code: string;
  stats: GolfStats;
}

/**
 * Which of the optional "Golf agressif" structural passes to run — lets
 * the UI offer one checkbox per pass instead of a single all-or-nothing
 * toggle, so a user can keep the passes that helped and individually
 * turn off whichever one broke their particular shader. Mirrors Rust's
 * `AggressiveOptions` field-for-field.
 */
export interface AggressiveOptions {
  eliminateDeadLocals: boolean;
  eliminateDeadStores: boolean;
  foldConstants: boolean;
  reduceConstantVectors: boolean;
  stripTrailingVoidReturn: boolean;
  compoundAssignments: boolean;
  mergeDeclarations: boolean;
  stripRedundantBraces: boolean;
}

export function allAggressiveOptions(on: boolean): AggressiveOptions {
  return {
    eliminateDeadLocals: on,
    eliminateDeadStores: on,
    foldConstants: on,
    reduceConstantVectors: on,
    stripTrailingVoidReturn: on,
    compoundAssignments: on,
    mergeDeclarations: on,
    stripRedundantBraces: on,
  };
}

/**
 * Runs the full golf pipeline: rename -> shorten numbers -> tight
 * layout, then whichever `aggressive` structural passes are turned on
 * — see each pass's docstring for exactly what it does and does not
 * touch. `aggressive` accepts a plain boolean (all passes on/off, the
 * common case) or an `AggressiveOptions` for per-pass control.
 */
export function golf(source: string, aggressive: boolean | AggressiveOptions = false): GolfResult {
  const options: AggressiveOptions =
    typeof aggressive === "boolean" ? allAggressiveOptions(aggressive) : aggressive;
  const inputChars = source.length;
  const tokens = tokenize(source);

  const renamable = findRenamable(tokens);

  const taken = new Set<string>([
    ...KEYWORDS,
    ...BUILTIN_FUNCTIONS,
    ...BUILTIN_VARIABLES,
    ...PROTECTED_HOST_NAMES,
  ]);
  // Also protect every identifier that appears in the source but isn't
  // being renamed (struct instance names whose type wasn't recognized,
  // struct member names excluded by findRenamable, anything the
  // declaration heuristic simply doesn't catch). Without this, a
  // freshly chosen short name can collide with one of these untouched
  // originals — e.g. an unrenamed `Foo f;` instance colliding with some
  // *other* variable the renamer picks "f" for, producing two different
  // variables declared under the same name in the same scope. Kept as a
  // single *global* exclusion (rather than scoped to wherever the
  // untouched name is actually used) — more conservative than strictly
  // necessary, but simple and always safe.
  const renamableSet = new Set(renamable.map((r) => r.name));
  for (const t of tokens) {
    if (t.kind === "ident" && !renamableSet.has(t.text)) taken.add(t.text);
  }

  // Scope-aware assignment: `taken` holds names visible *everywhere*
  // (keywords/builtins/protected/untouched-originals plus every
  // already-assigned Global name), while `localTaken.get(i)` holds
  // names already claimed within function scope `i` alone. Two locals
  // in *different* function scopes never conflict — `for(int i...)` in
  // one function and `for(int i...)` in a completely unrelated one can
  // both become `for(int a...)` — so each scope gets its own fresh
  // a,b,c... search rather than sharing one ever-growing sequence
  // across the whole file. Declarations are still assigned in frequency
  // order across *all* scopes together (that ordering comes from
  // findRenamable), so a hot local still outranks a rarely-used global
  // for the shortest names — only the pool of candidates each one draws
  // from is scope-partitioned.
  const localTaken = new Map<number, Set<string>>();
  const renameMap = new Map<string, string>();
  for (const { name, scope } of renamable) {
    const gen = nameGenerator();
    for (;;) {
      const candidate = gen.next().value as string;
      // A Global name is visible from *inside* every function too
      // (including, notably, a function's own name being visible within
      // its own body — e.g. for recursion), so assigning one must avoid
      // every scope's local names, not just other globals. A Local name
      // only needs to avoid globals and its own function's other
      // locals — a *different* function's locals are never visible
      // here, which is exactly the reuse this scope-partitioning is for.
      const collides =
        taken.has(candidate) ||
        (scope === null
          ? Array.from(localTaken.values()).some((s) => s.has(candidate))
          : (localTaken.get(scope)?.has(candidate) ?? false));
      if (collides) continue;
      if (scope === null) {
        taken.add(candidate);
      } else {
        if (!localTaken.has(scope)) localTaken.set(scope, new Set());
        localTaken.get(scope)!.add(candidate);
      }
      renameMap.set(name, candidate);
      break;
    }
  }

  let numbersShortened = 0;
  let items: Token[] = tokens.map((t, idx) => {
    let text = t.text;
    // A `.` right before an identifier makes it a field/swizzle selector
    // (`p.x`, `foo.bar`), never a variable reference — the tokenizer
    // can't tell `x`-as-name from `x`-as-swizzle-component, so without
    // this guard renaming an unrelated variable named `x` anywhere in
    // the file would also rewrite every `.x` swizzle, producing an
    // illegal field selector. Left untouched here.
    const precededByDot = idx > 0 && tokens[idx - 1].kind === "punct" && tokens[idx - 1].text === ".";
    if (t.kind === "ident" && !precededByDot) {
      text = renameMap.get(t.text) ?? t.text;
    } else if (t.kind === "number") {
      const shortened = shortenNumber(t.text);
      if (shortened !== t.text) numbersShortened++;
      text = shortened;
    }
    return { kind: t.kind, text, spaceBefore: t.spaceBefore };
  });

  const aggressiveStats = newAggressiveStats();
  if (options.eliminateDeadLocals) items = eliminateDeadLocals(items, aggressiveStats);
  if (options.eliminateDeadStores) items = eliminateDeadStores(items, aggressiveStats);
  if (options.foldConstants) items = foldConstants(items, aggressiveStats);
  if (options.reduceConstantVectors) items = reduceConstantVectors(items, aggressiveStats);
  if (options.compoundAssignments) items = compoundAssignments(items, aggressiveStats);
  if (options.mergeDeclarations) items = mergeDeclarations(items, aggressiveStats);
  if (options.stripRedundantBraces) items = stripRedundantBraces(items, aggressiveStats);
  if (options.stripTrailingVoidReturn) items = stripTrailingVoidReturn(items, aggressiveStats);

  const code = layout(items);
  const outputChars = code.length;
  const reductionPct = inputChars === 0 ? 0 : ((inputChars - outputChars) / inputChars) * 100;

  return {
    code,
    stats: {
      inputChars,
      outputChars,
      reductionPct,
      renamedCount: renameMap.size,
      numbersShortened,
      aggressive: aggressiveStats,
    },
  };
}
