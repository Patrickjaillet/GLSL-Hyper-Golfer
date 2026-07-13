use std::collections::HashSet;
use std::sync::OnceLock;

/// Words the renamer must never hand out as a *new* short name, and
/// must never rename when it sees them declared as a "type ident" pair
/// (this can only happen for the leading type token, but we keep the
/// check symmetric/defensive).
///
/// Built once and cached: `golf()` calls this on every invocation (once
/// per pass that needs it), and rebuilding a ~90-entry `HashSet` from a
/// fixed array every time is pure waste once a page is golfing on every
/// keystroke rather than once per button click.
pub fn keywords() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "attribute", "const", "uniform", "varying", "buffer", "shared", "coherent", "volatile",
            "restrict", "readonly", "writeonly", "atomic_uint", "layout", "centroid", "flat",
            "smooth", "noperspective", "patch", "sample", "invariant", "precise", "break",
            "continue", "do", "for", "while", "switch", "case", "default", "if", "else", "subroutine",
            "in", "out", "inout", "true", "false", "discard", "return", "struct", "void", "while",
            "precision", "highp", "mediump", "lowp", "define", "undef", "ifdef", "ifndef",
            "if", "endif", "error", "pragma", "extension", "version", "line",
            // types
            "float", "double", "int", "uint", "bool", "vec2", "vec3", "vec4", "dvec2", "dvec3",
            "dvec4", "bvec2", "bvec3", "bvec4", "ivec2", "ivec3", "ivec4", "uvec2", "uvec3", "uvec4",
            "mat2", "mat3", "mat4", "mat2x2", "mat2x3", "mat2x4", "mat3x2", "mat3x3", "mat3x4",
            "mat4x2", "mat4x3", "mat4x4", "sampler2D", "sampler3D", "samplerCube", "sampler2DShadow",
            "samplerCubeShadow", "sampler2DArray", "sampler2DArrayShadow", "isampler2D", "isampler3D",
            "isamplerCube", "isampler2DArray", "usampler2D", "usampler3D", "usamplerCube",
            "usampler2DArray", "image2D", "iimage2D", "uimage2D",
        ]
        .into_iter()
        .collect()
    })
}

/// The keywords that can legitimately introduce a declaration when
/// immediately followed by a user identifier: every real type, plus
/// `struct` itself (`struct Foo{...}` — `Foo` is the struct's own type
/// name, still safe and worth renaming, unlike its *members*; see
/// `struct_body_ranges` in `golfer.rs`). Deliberately narrower than
/// `keywords()`: qualifiers (`const`/`uniform`/...) and control-flow
/// keywords (`if`/`else`/`for`/`return`/...) are excluded because a
/// user identifier immediately after one of *those* is never a
/// declaration — a declaration's type token is always the one directly
/// adjacent to the identifier, qualifiers sit before the type, not the
/// name. Using the wider `keywords()` set here caused a real (if
/// harmless) false positive: `if(p){if(q)x;}else y;` renamed `y`
/// because `else` is a keyword immediately followed by a bare
/// identifier.
pub fn declaration_introducers() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        let mut s = type_keywords().clone();
        s.insert("struct");
        // `void` isn't a variable type (you can't declare `void x;`), so it's
        // deliberately absent from `type_keywords()` — but it's exactly how
        // every function's return type introduces the function's *name*
        // (`void mainImage(...)`), which is just as renamable as any other
        // declared identifier.
        s.insert("void");
        s
    })
}

/// The subset of `keywords()` that names an actual GLSL *type* (as
/// opposed to a qualifier like `const`/`uniform` or a control-flow
/// keyword like `if`/`for`). Used by the aggressive declaration-fusion
/// pass, which merges `float a=1.;float b=2.;` into `float a=1.,b=2.;`
/// — a merge is only ever attempted when the same type keyword opens
/// both statements, so qualifier-prefixed declarations (`const float a`)
/// are simply left alone rather than risking a mismatch.
pub fn type_keywords() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "float", "double", "int", "uint", "bool", "vec2", "vec3", "vec4", "dvec2", "dvec3",
            "dvec4", "bvec2", "bvec3", "bvec4", "ivec2", "ivec3", "ivec4", "uvec2", "uvec3", "uvec4",
            "mat2", "mat3", "mat4", "mat2x2", "mat2x3", "mat2x4", "mat3x2", "mat3x3", "mat3x4",
            "mat4x2", "mat4x3", "mat4x4", "sampler2D", "sampler3D", "samplerCube", "sampler2DShadow",
            "samplerCubeShadow", "sampler2DArray", "sampler2DArrayShadow", "isampler2D", "isampler3D",
            "isamplerCube", "isampler2DArray", "usampler2D", "usampler3D", "usamplerCube",
            "usampler2DArray", "image2D", "iimage2D", "uimage2D",
        ]
        .into_iter()
        .collect()
    })
}

/// Standard-library built-in functions. These are *called*, never
/// declared, but we must never rename a user identifier *to* one of
/// these (would silently shadow/alias a builtin) and must never treat
/// their appearance as a declaration.
pub fn builtin_functions() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "radians", "degrees", "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
            "asinh", "acosh", "atanh", "pow", "exp", "log", "exp2", "log2", "sqrt", "inversesqrt",
            "abs", "sign", "floor", "trunc", "round", "roundEven", "ceil", "fract", "mod", "modf",
            "min", "max", "clamp", "mix", "step", "smoothstep", "isnan", "isinf", "floatBitsToInt",
            "floatBitsToUint", "intBitsToFloat", "uintBitsToFloat", "fma", "frexp", "ldexp",
            "packUnorm2x16", "packSnorm2x16", "packUnorm4x8", "packSnorm4x8", "unpackUnorm2x16",
            "unpackSnorm2x16", "unpackUnorm4x8", "unpackSnorm4x8", "packHalf2x16", "unpackHalf2x16",
            "length", "distance", "dot", "cross", "normalize", "faceforward", "reflect", "refract",
            "matrixCompMult", "outerProduct", "transpose", "determinant", "inverse", "lessThan",
            "lessThanEqual", "greaterThan", "greaterThanEqual", "equal", "notEqual", "any", "all",
            "not", "textureSize", "texture", "textureProj", "textureLod", "textureOffset",
            "texelFetch", "texelFetchOffset", "textureProjOffset", "textureLodOffset",
            "textureProjLod", "textureProjLodOffset", "textureGrad", "textureGradOffset",
            "textureProjGrad", "textureProjGradOffset", "texture2D", "texture2DProj", "textureCube",
            "dFdx", "dFdy", "fwidth", "noise1", "noise2", "noise3", "noise4", "EmitVertex",
            "EndPrimitive", "barrier",
        ]
        .into_iter()
        .collect()
    })
}

/// GLSL/host built-in variables — never touched.
pub fn builtin_variables() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "gl_FragCoord",
            "gl_FragColor",
            "gl_FragData",
            "gl_FrontFacing",
            "gl_PointCoord",
            "gl_Position",
            "gl_PointSize",
            "gl_VertexID",
            "gl_InstanceID",
            "gl_FragDepth",
        ]
        .into_iter()
        .collect()
    })
}

/// Identifiers that are contractually fixed because JavaScript host
/// code references them by *name* (uniform lookups, the ShaderToy-style
/// `mainImage` entry point the runner calls into explicitly).
pub fn protected_host_names() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "main", "mainImage", "iResolution", "iTime", "iTimeDelta", "iFrame", "iMouse",
            "iDate", "iSampleRate", "iChannel0", "iChannel1", "iChannel2", "iChannel3",
        ]
        .into_iter()
        .collect()
    })
}
