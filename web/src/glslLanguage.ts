/**
 * A GLSL syntax-highlighting mode for CodeMirror 6, built on the
 * generic C-like `StreamParser` (`@codemirror/legacy-modes`) rather
 * than a full Lezer grammar — a hand-rolled tokenizer/highlighter is
 * plenty for coloring, and avoids maintaining a real GLSL grammar just
 * for display. There's a built-in `shader` mode in
 * `@codemirror/legacy-modes/mode/clike`, but it's GLSL ES 1.00-flavored
 * (`texture2D`, no `uint`/`switch`/`layout`) and doesn't know about
 * Shadertoy's own uniforms (`iResolution`, `mainImage`, ...) — this is
 * a from-scratch keyword set targeting GLSL ES 3.00 / Shadertoy usage
 * instead.
 *
 * This keyword/type/builtin list is duplicated from `rust-core/src/
 * vocab.rs` by necessity (this is TypeScript running in the browser,
 * `vocab.rs` is Rust compiled to wasm with no exported word-list API) —
 * it can drift out of sync with the golfer's own vocabulary without
 * breaking anything functionally, since this only affects highlighting,
 * never what gets renamed/protected.
 */
import { StreamLanguage, LanguageSupport } from "@codemirror/language";
import { clike } from "@codemirror/legacy-modes/mode/clike";
import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";

function words(list: string): Record<string, boolean> {
  const obj: Record<string, boolean> = {};
  for (const w of list.split(/\s+/)) if (w) obj[w] = true;
  return obj;
}

const KEYWORDS =
  "const attribute uniform varying buffer shared coherent volatile restrict readonly writeonly " +
  "layout centroid flat smooth noperspective patch sample invariant precise " +
  "break continue discard return for while do if else switch case default struct " +
  "in out inout precision highp mediump lowp";

const TYPES =
  "void bool int uint float double " +
  "vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 bvec2 bvec3 bvec4 dvec2 dvec3 dvec4 " +
  "mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 " +
  "sampler1D sampler2D sampler3D samplerCube sampler2DShadow samplerCubeShadow " +
  "sampler1DArray sampler2DArray sampler1DArrayShadow sampler2DArrayShadow " +
  "isampler1D isampler2D isampler3D isamplerCube usampler1D usampler2D usampler3D usamplerCube " +
  "atomic_uint image1D image2D image3D imageCube";

const BUILTIN_FUNCTIONS =
  "radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh " +
  "pow exp log exp2 log2 sqrt inversesqrt " +
  "abs sign floor trunc round roundEven ceil fract mod modf min max clamp mix step smoothstep " +
  "isnan isinf floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat fma frexp ldexp " +
  "length distance dot cross normalize faceforward reflect refract " +
  "matrixCompMult outerProduct transpose determinant inverse " +
  "lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not " +
  "texture textureSize textureProj textureLod textureOffset texelFetch texelFetchOffset " +
  "textureProjOffset textureLodOffset textureProjLod textureProjLodOffset textureGrad " +
  "textureGradOffset textureProjGrad textureProjGradOffset textureGather textureGatherOffset " +
  "dFdx dFdy dFdxCoarse dFdyCoarse dFdxFine dFdyFine fwidth fwidthCoarse fwidthFine " +
  "EmitVertex EndPrimitive barrier memoryBarrier groupMemoryBarrier";

const ATOMS =
  "true false " +
  "gl_FragCoord gl_FragColor gl_FragDepth gl_Position gl_PointSize gl_VertexID gl_InstanceID gl_FrontFacing " +
  "mainImage iResolution iTime iTimeDelta iFrame iMouse " +
  "iChannel0 iChannel1 iChannel2 iChannel3 iChannelTime iChannelResolution " +
  "iDate iSampleRate iFrameRate fragColor fragCoord";

const glslStreamParser = clike({
  name: "glsl",
  keywords: words(KEYWORDS),
  types: words(TYPES),
  builtin: words(BUILTIN_FUNCTIONS),
  blockKeywords: words("for while do if else struct switch"),
  atoms: words(ATOMS),
});

export const glslLanguage = StreamLanguage.define(glslStreamParser);

const COMPLETIONS = [
  ...KEYWORDS.split(/\s+/).map((label) => ({ label, type: "keyword" })),
  ...TYPES.split(/\s+/).map((label) => ({ label, type: "type" })),
  ...BUILTIN_FUNCTIONS.split(/\s+/).map((label) => ({ label, type: "function" })),
  ...ATOMS.split(/\s+/).map((label) => ({ label, type: "variable" })),
].filter((c) => c.label);

const glslCompletionSource: CompletionSource = (context) => {
  const word = context.matchBefore(/\w+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: COMPLETIONS, validFor: /^\w*$/ };
};

/** GLSL language + basic word-list autocompletion, ready to drop into an `EditorState`'s extensions. */
export function glsl(): LanguageSupport {
  return new LanguageSupport(glslLanguage, [autocompletion({ override: [glslCompletionSource] })]);
}
