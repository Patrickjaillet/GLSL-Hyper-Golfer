import { golf, type AggressiveOptions, type GolfResult } from "./golfer";
import {
  ShaderRunner,
  MultiPassRunner,
  type RenderError,
  type MultiPassError,
  type PassSource,
  type PassId,
  type BufferSlot,
  type ChannelWiring,
} from "./renderer";
import { initWasmGolfer, wasmGolf } from "./wasmGolfer";
import { createSourceEditor, createReadOnlyEditor, setEditorContent, setErrorLineHighlight } from "./editor";
import { t, getLocale, setLocale, onLocaleChange } from "./i18n";
import type { EditorView } from "@codemirror/view";

// Prefer the wasm build of the actual Rust engine — same code as the
// CLI and cargo tests, so no TS/Rust divergence risk — falling back to
// the embedded TypeScript port only if wasm fails to load (older
// browser, blocked by CSP, offline without the .wasm asset cached, ...).
let golfImpl = golf;
let engineLabel = "TypeScript embarqué (repli)";
const wasmReady = initWasmGolfer()
  .then(() => {
    golfImpl = wasmGolf;
    engineLabel = "Rust → wasm";
  })
  .catch((err) => {
    console.warn("wasm engine unavailable, falling back to the TypeScript port:", err);
  });

const DEFAULT_IMAGE_CODE = `void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    // Normalized pixel coordinates (from 0 to 1)
    vec2 uv = fragCoord/iResolution.xy;

    // Time varying pixel color
    vec3 col = 0.5 + 0.5*cos(iTime+uv.xyx+vec3(0,2,4));

    // Output to screen
    fragColor = vec4(col,1.0);
}`;

// ---------------------------------------------------------------------
// Project model — a Shadertoy-shaped project: shared "Common" code, up
// to 4 feedback/composable buffers (A-D), and the final "Image" pass.
// Each buffer/Image has 4 iChannel slots that can be wired to any
// *active* buffer's output (texture/video/audio/webcam/cubemap channel
// types aren't supported yet — wiring UI only offers "None" or another
// buffer). See ROADMAP.md for what's intentionally out of scope this
// round.
// ---------------------------------------------------------------------
type BufferId = "common" | BufferSlot | "image";
const BUFFER_SLOTS: BufferSlot[] = ["bufferA", "bufferB", "bufferC", "bufferD"];
const BUFFER_LABELS: Record<BufferId, string> = {
  common: "Common",
  bufferA: "Buffer A",
  bufferB: "Buffer B",
  bufferC: "Buffer C",
  bufferD: "Buffer D",
  image: "Image",
};

interface PassState {
  code: string;
  channels: ChannelWiring[];
}

function emptyChannels(): ChannelWiring[] {
  return [{ kind: "none" }, { kind: "none" }, { kind: "none" }, { kind: "none" }];
}

let common = "";
let imageState: PassState = { code: DEFAULT_IMAGE_CODE, channels: emptyChannels() };
let bufferStates: Partial<Record<BufferSlot, PassState>> = {};
let currentTab: BufferId = "image";

// ---------------------------------------------------------------------
// Autosave — a page refresh (or an accidental tab close) shouldn't lose
// the user's in-progress project. Deliberately a *single* auto-saved
// slot, not the "several named drafts" originally envisioned in
// ROADMAP.md: that needs its own save/load/delete UI, a separate and
// larger unit of work than "don't lose my work on refresh".
// ---------------------------------------------------------------------
const AUTOSAVE_KEY = "glslgolf-autosave";

interface SavedProject {
  common: string;
  bufferStates: Partial<Record<BufferSlot, PassState>>;
  imageState: PassState;
  currentTab: BufferId;
  protectedNames: string;
}

function isValidChannelWiring(x: unknown): x is ChannelWiring {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  if (c.kind === "none" || c.kind === "cubemap" || c.kind === "volume" || c.kind === "keyboard") return true;
  return c.kind === "buffer" && typeof c.id === "string" && (BUFFER_SLOTS as string[]).includes(c.id);
}

function isValidPassState(x: unknown): x is PassState {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return typeof p.code === "string" && Array.isArray(p.channels) && p.channels.length === 4 && p.channels.every(isValidChannelWiring);
}

/**
 * Parses and validates the autosaved project from localStorage —
 * never trusts stored JSON blindly (a previous app version's shape, a
 * hand-edited value, or plain corruption could all be sitting there),
 * so any structural mismatch falls back to `null` (caller keeps the
 * hardcoded default project) rather than crashing or loading a
 * half-valid state.
 */
function loadSavedProject(): SavedProject | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.common !== "string") return null;
    if (!isValidPassState(parsed.imageState)) return null;
    if (typeof parsed.bufferStates !== "object" || parsed.bufferStates === null) return null;

    const bufferStates: Partial<Record<BufferSlot, PassState>> = {};
    for (const slot of BUFFER_SLOTS) {
      const v = (parsed.bufferStates as Record<string, unknown>)[slot];
      if (v === undefined) continue;
      if (!isValidPassState(v)) return null;
      bufferStates[slot] = v;
    }

    const tab = parsed.currentTab;
    const tabIsValid =
      tab === "common" || tab === "image" || (typeof tab === "string" && bufferStates[tab as BufferSlot] !== undefined);
    const currentTab: BufferId = tabIsValid ? (tab as BufferId) : "image";
    // Optional field, added after the first version of autosave shipped
    // — an older saved project simply won't have it, treated as "".
    const protectedNames = typeof parsed.protectedNames === "string" ? parsed.protectedNames : "";

    return { common: parsed.common, bufferStates, imageState: parsed.imageState, currentTab, protectedNames };
  } catch {
    return null;
  }
}

function saveProjectToLocalStorage(): void {
  try {
    const data: SavedProject = { common, bufferStates, imageState, currentTab, protectedNames: protectedNamesInput.value };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or unavailable (private browsing, quota) — autosave
    // is a convenience, never something the app should break over.
  }
}

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
/** Debounced so a burst of keystrokes writes to localStorage once, not per character. */
function scheduleAutosave(): void {
  if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveProjectToLocalStorage, 400);
}

const savedProject = loadSavedProject();
// Applied to the actual <input> once it exists (queried much further
// down, alongside the rest of the DOM element lookups) — the plain
// project-state globals above can be reassigned directly at this point
// in the module, but there's no DOM to touch yet this early.
let restoredProtectedNames = "";
if (savedProject) {
  common = savedProject.common;
  bufferStates = savedProject.bufferStates;
  imageState = savedProject.imageState;
  currentTab = savedProject.currentTab;
  restoredProtectedNames = savedProject.protectedNames;
}

function activeSlots(): BufferSlot[] {
  return BUFFER_SLOTS.filter((id) => bufferStates[id]);
}

function allTabs(): BufferId[] {
  return ["common", ...activeSlots(), "image"];
}

function getPassState(id: BufferId): PassState | { code: string; channels: null } {
  if (id === "common") return { code: common, channels: null };
  if (id === "image") return imageState;
  return bufferStates[id]!;
}

function setCurrentCode(code: string): void {
  if (currentTab === "common") common = code;
  else if (currentTab === "image") imageState.code = code;
  else bufferStates[currentTab]!.code = code;
}

/** Every pass whose full source is `common + "\n" + own code` — i.e. everything except "common" itself. */
function compilablePasses(): { id: Exclude<BufferId, "common">; state: PassState }[] {
  return [
    ...activeSlots().map((id) => ({ id, state: bufferStates[id]! })),
    { id: "image" as const, state: imageState },
  ];
}

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="shell">
    <header class="masthead">
      <div class="brand">
        <span class="mark">GLSL⇥</span>
        <h1 data-i18n-title="app.tagline" title="">Hyper-Golfing Engine</h1>
      </div>
      <nav class="tab-bar" id="tab-bar">
        <button class="tab-btn" data-tab="source" type="button" data-i18n="tab.source">Source</button>
        <button class="tab-btn" data-tab="golfed" type="button" data-i18n="tab.golfed">Golfé</button>
        <button class="tab-btn" data-tab="viewport" type="button" data-i18n="tab.viewport">Viewport</button>
      </nav>
      <button class="lang-toggle" id="lang-toggle" type="button" data-i18n-title="lang.toggle.title"></button>
      <div class="engine-pill" data-i18n-title="engine.tooltip" title="">
        <span class="dot cyan"></span><span data-i18n="engine.activeLabel">moteur actif : </span><b id="engine-label">…</b>
      </div>
    </header>

    <div class="workspace" id="workspace">
      <section class="panel active-tab" id="panel-source" data-panel="source">
        <div class="buffer-tabs" id="buffer-tabs"></div>
        <div class="channel-row" id="channel-row" hidden></div>
        <div class="editor" id="source-editor-mount"></div>
        <div class="actions">
          <label class="golf-level-field" data-i18n-title="golfLevel.title" title="">
            <span data-i18n="golfLevel.label">Niveau</span>
            <select id="golf-level-select">
              <option value="safe" data-i18n="golfLevel.safe">Sûr</option>
              <option value="balanced" data-i18n="golfLevel.balanced">Équilibré</option>
              <option value="aggressive" data-i18n="golfLevel.aggressive">Agressif</option>
              <option value="custom" data-i18n="golfLevel.custom" hidden>Personnalisé</option>
            </select>
          </label>
          <button class="btn ghost small" id="import-btn" type="button" data-i18n-title="btn.import.title" title="">⇩ Shadertoy</button>
          <button class="btn ghost small" id="export-btn" type="button" data-i18n-title="btn.export.title" title="">⇧ Export</button>
          <button class="btn ghost small" id="passes-btn" type="button" aria-haspopup="true" aria-expanded="false" data-i18n-title="btn.passes.title" title="">⚙ Passes</button>
          <button class="btn ghost" id="reset-btn" type="button" data-i18n="btn.reset">Réinitialiser</button>
          <button class="btn primary" id="run-btn" type="button" data-i18n="btn.run" data-i18n-title="btn.run.title" title="">Exécuter le golfing</button>
        </div>
      </section>

      <div class="resizer" id="resizer-1" tabindex="0" data-i18n-title="buffer.resizer.title" title=""></div>

      <section class="panel" id="panel-golfed" data-panel="golfed">
        <div class="panel-head">
          <div class="panel-title"><span class="dot cyan"></span><span data-i18n="panel.golfed.prefix">Golfé — </span><span id="golfed-tab-label">Image</span></div>
          <label class="pretty-toggle" data-i18n-title="toggle.pretty.title" title="">
            <input type="checkbox" id="pretty-toggle" />
            <span data-i18n="toggle.pretty.label">Version justifiée</span>
          </label>
          <button class="btn copy" id="copy-btn" type="button" data-i18n="btn.copy">Copier</button>
        </div>
        <div class="output-code" id="output-editor-mount"></div>

        <div class="meter-block">
          <div class="meter-row">
            <span class="meter-label" data-i18n="meter.label">Réduction totale</span>
            <div class="meter-ticks" id="ticks"></div>
            <span class="meter-value" id="ratio-value">0%</span>
          </div>
          <div class="stat-strip" aria-live="polite">
            <span><b id="c-in">0</b> <span data-i18n="stat.inputChars">car. source</span></span>
            <span><b id="c-out">0</b> <span data-i18n="stat.outputChars">car. golfés</span></span>
            <span><b id="c-out-bytes">0</b> <span data-i18n="stat.outputBytes">octets golfés (UTF-8)</span></span>
            <span><b id="c-renamed">0</b> <span data-i18n="stat.renamed">identifiants renommés</span></span>
            <span><b id="c-numbers">0</b> <span data-i18n="stat.numbers">nombres raccourcis</span></span>
          </div>
          <div class="size-badges" id="size-badges" aria-live="polite"></div>
          <div class="stat-strip" id="aggressive-stats" hidden aria-live="polite">
            <span><b id="c-dead">0</b> <span data-i18n="stat.deadLocals">locaux morts supprimés</span></span>
            <span><b id="c-stores">0</b> <span data-i18n="stat.deadStores">écritures mortes supprimées</span></span>
            <span><b id="c-folded">0</b> <span data-i18n="stat.folded">constantes repliées</span></span>
            <span><b id="c-vectors">0</b> <span data-i18n="stat.constantVectors">vecteurs constants réduits</span></span>
            <span><b id="c-compound">0</b> <span data-i18n="stat.compound">affectations composées</span></span>
            <span><b id="c-incdec">0</b> <span data-i18n="stat.incDec">incréments/décréments</span></span>
            <span><b id="c-ternary">0</b> <span data-i18n="stat.ternary">ternaires depuis if/else</span></span>
            <span><b id="c-merged">0</b> <span data-i18n="stat.merged">déclarations fusionnées</span></span>
            <span><b id="c-braces">0</b> <span data-i18n="stat.braces">blocs d'accolades supprimés</span></span>
            <span><b id="c-trailing-return">0</b> <span data-i18n="stat.trailingReturn">return finaux supprimés</span></span>
          </div>
          <div class="stat-strip" id="per-pass-stats"></div>
        </div>

        <div class="warning-banner" id="warning-banner" hidden></div>
        <div class="error-banner" id="error-banner" aria-live="assertive"></div>
      </section>

      <div class="resizer" id="resizer-2" tabindex="0" data-i18n-title="buffer.resizer.title" title=""></div>

      <div class="viewport-wrap" id="panel-viewport" data-panel="viewport">
        <div class="panel-head">
          <div class="panel-title"><span class="dot cyan"></span><span data-i18n="panel.viewport.title">Viewport temps réel</span></div>
          <label class="compare-toggle" data-i18n-title="toggle.compare.title" title="">
            <input type="checkbox" id="compare-toggle" />
            <span data-i18n="toggle.compare.label">Comparer</span>
          </label>
        </div>
        <div class="viewport-split">
          <div class="viewport-frame" id="frame-source" hidden>
            <div class="viewport-label" data-i18n="viewport.label.source">source</div>
            <canvas id="glcanvas-source"></canvas>
          </div>
          <div class="viewport-frame" id="frame-golfed">
            <div class="viewport-label" id="label-golfed" data-i18n="viewport.label.golfed" hidden>golfé</div>
            <canvas id="glcanvas"></canvas>
            <div class="viewport-hud">
              <span class="fps"><b id="fps-value">--</b> fps</span>
              <span id="res-value">--×--</span>
            </div>
            <div class="viewport-controls">
              <button class="icon-btn" id="pause-btn" type="button" data-i18n-title="pause.title" data-i18n-aria-label="pause.ariaLabel" title="" aria-label="">⏸</button>
              <button class="icon-btn" id="screenshot-btn" type="button" data-i18n-title="screenshot.title" data-i18n-aria-label="screenshot.title" title="" aria-label="">📷</button>
              <button class="icon-btn" id="record-btn" type="button" data-i18n-title="record.title" data-i18n-aria-label="record.title" title="" aria-label="">⏺</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="passes-popover" id="passes-popover" hidden>
      <label data-i18n-title="pass.deadLocals.title" title="">
        <input type="checkbox" id="pass-dead-locals" checked /><span data-i18n="pass.deadLocals.label">locaux morts</span>
      </label>
      <label data-i18n-title="pass.deadStores.title" title="">
        <input type="checkbox" id="pass-dead-stores" checked /><span data-i18n="pass.deadStores.label">écritures mortes</span>
      </label>
      <label data-i18n-title="pass.foldConstants.title" title="">
        <input type="checkbox" id="pass-fold-constants" checked /><span data-i18n="pass.foldConstants.label">constantes</span>
      </label>
      <label data-i18n-title="pass.constantVectors.title" title="">
        <input type="checkbox" id="pass-constant-vectors" checked /><span data-i18n="pass.constantVectors.label">vecteurs constants</span>
      </label>
      <label data-i18n-title="pass.compound.title" title="">
        <input type="checkbox" id="pass-compound" checked /><span data-i18n="pass.compound.label">affectations composées</span>
      </label>
      <label data-i18n-title="pass.incDec.title" title="">
        <input type="checkbox" id="pass-inc-dec" checked /><span data-i18n="pass.incDec.label">incréments/décréments</span>
      </label>
      <label data-i18n-title="pass.ternary.title" title="">
        <input type="checkbox" id="pass-ternary" checked /><span data-i18n="pass.ternary.label">ternaires</span>
      </label>
      <label data-i18n-title="pass.merge.title" title="">
        <input type="checkbox" id="pass-merge" checked /><span data-i18n="pass.merge.label">fusion déclarations</span>
      </label>
      <label data-i18n-title="pass.braces.title" title="">
        <input type="checkbox" id="pass-braces" checked /><span data-i18n="pass.braces.label">accolades</span>
      </label>
      <label data-i18n-title="pass.trailingReturn.title" title="">
        <input type="checkbox" id="pass-trailing-return" checked /><span data-i18n="pass.trailingReturn.label">return finaux</span>
      </label>
      <hr class="passes-popover-sep" />
      <label class="protected-names-field" data-i18n-title="protectedNames.title" title="">
        <span data-i18n="protectedNames.label">noms protégés</span>
        <input type="text" id="protected-names-input" data-i18n-placeholder="protectedNames.placeholder" placeholder="" />
      </label>
    </div>
  </div>
`;

function applyTranslations(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel!));
  });
  document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  });
  langToggle.textContent = getLocale() === "fr" ? "EN" : "FR";
  renderBufferTabs();
  renderChannelRow();
  renderOutput();
  updateLegacyWarnings();
  renderSizeBadges(lastTotalOutBytes);
  sourceEditor.contentDOM.setAttribute("aria-label", t("editor.source.ariaLabel"));
  outputEditor.contentDOM.setAttribute("aria-label", t("editor.output.ariaLabel"));
}

const bufferTabsEl = document.getElementById("buffer-tabs")!;
const channelRowEl = document.getElementById("channel-row") as HTMLElement;
const golfedTabLabel = document.getElementById("golfed-tab-label")!;
const ticks = document.getElementById("ticks")!;
const ratioValue = document.getElementById("ratio-value")!;
const cIn = document.getElementById("c-in")!;
const cOut = document.getElementById("c-out")!;
const cOutBytes = document.getElementById("c-out-bytes")!;
const sizeBadges = document.getElementById("size-badges")!;
const cRenamed = document.getElementById("c-renamed")!;
const cNumbers = document.getElementById("c-numbers")!;
const aggressiveStatsRow = document.getElementById("aggressive-stats")!;
const cDead = document.getElementById("c-dead")!;
const cStores = document.getElementById("c-stores")!;
const cFolded = document.getElementById("c-folded")!;
const cVectors = document.getElementById("c-vectors")!;
const cCompound = document.getElementById("c-compound")!;
const cIncDec = document.getElementById("c-incdec")!;
const cTernary = document.getElementById("c-ternary")!;
const cBraces = document.getElementById("c-braces")!;
const cTrailingReturn = document.getElementById("c-trailing-return")!;
const cMerged = document.getElementById("c-merged")!;
const perPassStats = document.getElementById("per-pass-stats")!;
const golfLevelSelect = document.getElementById("golf-level-select") as HTMLSelectElement;
const passDeadLocals = document.getElementById("pass-dead-locals") as HTMLInputElement;
const passDeadStores = document.getElementById("pass-dead-stores") as HTMLInputElement;
const passFoldConstants = document.getElementById("pass-fold-constants") as HTMLInputElement;
const passConstantVectors = document.getElementById("pass-constant-vectors") as HTMLInputElement;
const passCompound = document.getElementById("pass-compound") as HTMLInputElement;
const passIncDec = document.getElementById("pass-inc-dec") as HTMLInputElement;
const passTernary = document.getElementById("pass-ternary") as HTMLInputElement;
const passMerge = document.getElementById("pass-merge") as HTMLInputElement;
const passBraces = document.getElementById("pass-braces") as HTMLInputElement;
const passTrailingReturn = document.getElementById("pass-trailing-return") as HTMLInputElement;
const passCheckboxes = [
  passDeadLocals,
  passDeadStores,
  passFoldConstants,
  passConstantVectors,
  passCompound,
  passIncDec,
  passTernary,
  passMerge,
  passBraces,
  passTrailingReturn,
];

type GolfLevel = "safe" | "balanced" | "aggressive";

// "Balanced" is every pass that only ever shrinks text without
// changing the code's visible *shape* — dead code removal, constant
// folding, compound-assignment/increment rewriting. "Aggressive" adds
// the passes that also restructure control flow syntactically
// (if/else -> ternary, brace stripping, declaration merging, trailing
// return removal) — still provably correct (see ROADMAP.md for each
// pass's safety argument), just a bigger visual diff from the source.
// There's deliberately no fourth "max-risk" tier: every implemented
// aggressive pass is safe-by-construction, not heuristic-risky: a few
// were considered and *not* built this way (CSE, function inlining)
// specifically because they couldn't meet that bar without real
// data-flow analysis — see ROADMAP.md section 1.1.
const GOLF_LEVEL_PASSES: Record<GolfLevel, HTMLInputElement[]> = {
  safe: [],
  balanced: [passDeadLocals, passDeadStores, passFoldConstants, passConstantVectors, passCompound, passIncDec],
  aggressive: passCheckboxes,
};

const protectedNamesInput = document.getElementById("protected-names-input") as HTMLInputElement;
protectedNamesInput.value = restoredProtectedNames;
const passesBtn = document.getElementById("passes-btn") as HTMLButtonElement;
const passesPopover = document.getElementById("passes-popover") as HTMLElement;
const importBtn = document.getElementById("import-btn") as HTMLButtonElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
const langToggle = document.getElementById("lang-toggle") as HTMLButtonElement;
const engineLabelEl = document.getElementById("engine-label")!;
const errorBanner = document.getElementById("error-banner")!;
const warningBanner = document.getElementById("warning-banner")!;
const runBtn = document.getElementById("run-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement;
const prettyToggle = document.getElementById("pretty-toggle") as HTMLInputElement;
const pauseBtn = document.getElementById("pause-btn") as HTMLButtonElement;
const screenshotBtn = document.getElementById("screenshot-btn") as HTMLButtonElement;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
const fpsValue = document.getElementById("fps-value")!;
const resValue = document.getElementById("res-value")!;
const canvas = document.getElementById("glcanvas") as HTMLCanvasElement;
const viewportFrame = document.getElementById("frame-golfed") as HTMLElement;
const compareToggle = document.getElementById("compare-toggle") as HTMLInputElement;
const frameSource = document.getElementById("frame-source") as HTMLElement;
const labelGolfed = document.getElementById("label-golfed")!;
const canvasSource = document.getElementById("glcanvas-source") as HTMLCanvasElement;
const workspaceEl = document.getElementById("workspace") as HTMLElement;
const resizer1 = document.getElementById("resizer-1") as HTMLElement;
const resizer2 = document.getElementById("resizer-2") as HTMLElement;
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab-btn"));
const panelSource = document.getElementById("panel-source")!;
const panelGolfed = document.getElementById("panel-golfed")!;
const panelViewport = document.getElementById("panel-viewport")!;

langToggle.addEventListener("click", () => setLocale(getLocale() === "fr" ? "en" : "fr"));
onLocaleChange(applyTranslations);

const TICK_COUNT = 24;
for (let i = 0; i < TICK_COUNT; i++) {
  const tick = document.createElement("div");
  tick.className = "tick";
  ticks.appendChild(tick);
}

// GLSL ES 1.00-only sampling functions — this app always runs shaders
// in a WebGL2/ES 3.00 context (`MultiPassRunner`/`ShaderRunner`'s GL2
// path both declare `#version 300 es`), where these simply don't exist
// as builtins. A shader ported from an old ES 1.00/WebGL1 codebase that
// still calls them fails to compile with an unhelpful "undeclared
// identifier" from the driver — this catches it before that point and
// names the actual problem. Deliberately just a word-boundary regex
// scan, not real parsing: matches the rest of this token-heuristic
// codebase, and a false positive here only produces an extra hint, not
// a broken golf.
const LEGACY_GLSL_FUNCTIONS = [
  "texture2DProjLod",
  "texture2DProj",
  "texture2DLod",
  "texture2D",
  "textureCubeLod",
  "textureCube",
  "texture3DProj",
  "texture3D",
  "shadow2DProj",
  "shadow2D",
  "texture1DProj",
  "texture1D",
];

function detectLegacyGlslFunctions(code: string): string[] {
  const found: string[] = [];
  for (const fn of LEGACY_GLSL_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`).test(code)) found.push(fn);
  }
  return found;
}

/**
 * Purely cosmetic re-indentation of already-golfed code for the
 * "Version justifiée"/"Formatted view" display toggle — breaks the
 * one-liner back onto multiple indented lines after `;`/`{`/`}` so it
 * reads like normal code. Never touches the actual golfed string: what
 * gets compiled and what gets copied always stay the true minified
 * output, this only changes what the read-only editor shows.
 */
function prettyPrintGolfed(code: string): string {
  let out = "";
  let depth = 0;
  let parenDepth = 0;
  const indent = (d: number) => "  ".repeat(Math.max(0, d));

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[") {
      parenDepth++;
      out += ch;
    } else if (ch === ")" || ch === "]") {
      parenDepth = Math.max(0, parenDepth - 1);
      out += ch;
    } else if (ch === "{") {
      depth++;
      out += ch + "\n" + indent(depth);
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      out = out.replace(/[ \t]*\n?[ \t]*$/, "\n" + indent(depth));
      out += "}\n" + indent(depth);
    } else if (ch === ";" && parenDepth === 0) {
      out += ";\n" + indent(depth);
    } else {
      out += ch;
    }
  }

  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .filter((line, idx, arr) => line !== "" || arr[idx - 1] !== "")
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------
// Editors — CodeMirror 6 (see editor.ts/glslLanguage.ts). One editable
// instance for whichever buffer tab is selected, one read-only instance
// showing that tab's golfed output.
// ---------------------------------------------------------------------
const sourceEditorMount = document.getElementById("source-editor-mount")!;
const outputEditorMount = document.getElementById("output-editor-mount")!;
const sourceEditor: EditorView = createSourceEditor(
  sourceEditorMount,
  getPassState(currentTab).code,
  (doc) => {
    setCurrentCode(doc);
    scheduleAutosave();
  },
  t("editor.source.ariaLabel"),
);
const outputEditor: EditorView = createReadOnlyEditor(outputEditorMount, t("output.placeholder"), t("editor.output.ariaLabel"));

// ---------------------------------------------------------------------
// Buffer tabs (Common / Buffer A-D / Image) + per-pass channel wiring.
// ---------------------------------------------------------------------
function renderChannelRow(): void {
  if (currentTab === "common") {
    channelRowEl.hidden = true;
    channelRowEl.innerHTML = "";
    return;
  }
  const state = getPassState(currentTab) as PassState;
  const options = activeSlots();
  channelRowEl.hidden = false;
  channelRowEl.innerHTML = state.channels
    .map((ch, i) => {
      const opts = [`<option value="none"${ch.kind === "none" ? " selected" : ""}>${t("channel.none")}</option>`]
        .concat(
          options.map(
            (slot) =>
              `<option value="${slot}"${ch.kind === "buffer" && ch.id === slot ? " selected" : ""}>${BUFFER_LABELS[slot]}</option>`,
          ),
        )
        .concat([
          `<option value="cubemap"${ch.kind === "cubemap" ? " selected" : ""}>${t("channel.cubemap")}</option>`,
          `<option value="volume"${ch.kind === "volume" ? " selected" : ""}>${t("channel.volume")}</option>`,
          `<option value="keyboard"${ch.kind === "keyboard" ? " selected" : ""}>${t("channel.keyboard")}</option>`,
        ])
        .join("");
      return `<label>iChannel${i} <select data-channel-index="${i}">${opts}</select></label>`;
    })
    .join("");
  channelRowEl.querySelectorAll<HTMLSelectElement>("select[data-channel-index]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const idx = Number(sel.dataset.channelIndex);
      const wiring: ChannelWiring =
        sel.value === "none" || sel.value === "cubemap" || sel.value === "volume" || sel.value === "keyboard"
          ? { kind: sel.value }
          : { kind: "buffer", id: sel.value as BufferSlot };
      (getPassState(currentTab) as PassState).channels[idx] = wiring;
      // Switching to/from "buffer"/"none" only ever changed which
      // texture gets *bound* at draw time (always sampler2D either
      // way), harmless to leave for the next manual Run. But
      // "cubemap"/"volume" change the GLSL sampler *type* the shader
      // itself declares (samplerCube/sampler3D) -- the already-
      // compiled program would go stale immediately, sampling with
      // the wrong type until the user happened to run again. Always
      // re-golfing on any channel change avoids that staleness window
      // rather than only fixing it for the two kinds that need it.
      golfProject();
      scheduleAutosave();
    });
  });
}

function renderBufferTabs(): void {
  const tabs = allTabs();
  bufferTabsEl.innerHTML =
    tabs
      .map((id) => {
        const removable = BUFFER_SLOTS.includes(id as BufferSlot);
        const closeBtn = removable
          ? `<span class="buffer-tab-close" data-remove="${id}" role="button" tabindex="0" title="${t("buffer.remove.title")}" aria-label="${t("buffer.remove.title")} (${BUFFER_LABELS[id]})">✕</span>`
          : "";
        return `<button class="buffer-tab-btn${id === currentTab ? " active" : ""}" data-buffer-tab="${id}" type="button" aria-pressed="${id === currentTab}">${BUFFER_LABELS[id]}${closeBtn}</button>`;
      })
      .join("") +
    (activeSlots().length < BUFFER_SLOTS.length
      ? `<button class="buffer-tab-add" id="add-buffer-btn" type="button">${t("buffer.add")}</button>`
      : "");

  bufferTabsEl.querySelectorAll<HTMLButtonElement>("[data-buffer-tab]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-remove]")) return;
      switchTab(btn.dataset.bufferTab as BufferId);
    });
  });
  bufferTabsEl.querySelectorAll<HTMLElement>("[data-remove]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      removeBuffer(el.dataset.remove as BufferSlot);
    });
    // A `role="button"` span (not a real <button>) doesn't get Enter/Space
    // activation for free — wire it explicitly for keyboard users.
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        removeBuffer(el.dataset.remove as BufferSlot);
      }
    });
  });
  const addBtn = document.getElementById("add-buffer-btn");
  addBtn?.addEventListener("click", addBuffer);
}

function switchTab(id: BufferId): void {
  currentTab = id;
  setEditorContent(sourceEditor, getPassState(id).code);
  renderBufferTabs();
  renderChannelRow();
  golfedTabLabel.textContent = BUFFER_LABELS[id];
  renderOutput();
  scheduleAutosave();
}

function addBuffer(): void {
  const free = BUFFER_SLOTS.find((id) => !bufferStates[id]);
  if (!free) return;
  bufferStates[free] = { code: "", channels: emptyChannels() };
  switchTab(free);
}

function removeBuffer(id: BufferSlot): void {
  delete bufferStates[id];
  // Any other pass wired to the removed buffer would otherwise silently
  // reference a slot that no longer exists — reset those to "none"
  // rather than leaving a dangling reference.
  for (const pass of [...activeSlots().map((s) => bufferStates[s]!), imageState]) {
    pass.channels = pass.channels.map((ch) => (ch.kind === "buffer" && ch.id === id ? { kind: "none" } : ch));
  }
  if (currentTab === id) switchTab("image");
  else {
    renderBufferTabs();
    renderChannelRow();
  }
}

// ---------------------------------------------------------------------
// Rendering: MultiPassRunner (WebGL2) with a ShaderRunner (WebGL1/2,
// single-pass) fallback for browsers without WebGL2 — multi-buffer
// projects simply can't run there, but a plain Image-only project still
// renders (any channel wired to a buffer reads black, same graceful
// degradation `ShaderRunner` already does for iChannel0-3).
// ---------------------------------------------------------------------
let mpRunner: MultiPassRunner | null = null;
let legacyRunner: ShaderRunner | null = null;
let mpSourceRunner: MultiPassRunner | null = null;
let legacySourceRunner: ShaderRunner | null = null;
const compatMode = { active: false };

/**
 * Maps a driver's `ERROR: 0:N: ...` line number (which counts from the
 * top of the *wrapped* source, uniform header included) back to a line
 * within whichever editor is showing the code that actually failed —
 * using `bodyStartLine`, computed in `renderer.ts` from the exact
 * header text used for that compile, so this never hardcodes a header
 * line count that could silently drift out of sync.
 */
function computeErrorLine(err: RenderError | MultiPassError): number | null {
  const match = err.log.match(/ERROR:\s*\d+:(\d+):/);
  if (!match || !err.bodyStartLine) return null;
  const line = Number(match[1]) - err.bodyStartLine + 1;
  return line >= 1 ? line : null;
}

/** How many lines `common + "\n"` occupies at the front of every pass's compiled source — needed to translate a wrapped-body line back to a line within *just* the pass's own code (which is all the source editor ever shows; it never displays Common inline). */
function commonPrefixLineCount(): number {
  return (common + "\n").split("\n").length - 1;
}

function reportError(err: RenderError | MultiPassError | null): void {
  if (!err) {
    errorBanner.classList.remove("visible");
    errorBanner.textContent = "";
    setErrorLineHighlight(outputEditor, null);
    return;
  }
  errorBanner.classList.add("visible");
  const passLabel = "passId" in err ? `${BUFFER_LABELS[err.passId as BufferId]} / ${err.stage}` : err.stage;
  errorBanner.textContent = t("error.compileError", { pass: passLabel, log: err.log });

  // This error is about the *golfed* code (the only thing `onError`
  // ever fires for) — switch to whichever tab actually failed so the
  // highlight lands somewhere visible, then highlight it. Almost always
  // line 1 in practice since golfed code is normally a single line;
  // still correct, and genuinely useful once "Version justifiée" is
  // off (the state the highlighted line number is actually valid for —
  // the compiled source was the raw minified string, not the
  // client-side reformatted view).
  const failingTab: BufferId = "passId" in err ? (err.passId as BufferId) : "image";
  if (failingTab !== currentTab) switchTab(failingTab);
  setErrorLineHighlight(outputEditor, computeErrorLine(err));
}

try {
  mpRunner = new MultiPassRunner(canvas);
  mpRunner.onFps = (fps) => {
    fpsValue.textContent = fps.toFixed(0);
  };
  mpRunner.onError = reportError;
  mpRunner.start();
} catch (e) {
  console.warn("WebGL2 multi-pass unavailable, falling back to single-pass WebGL1/2:", e);
  compatMode.active = true;
  try {
    legacyRunner = new ShaderRunner(canvas);
    legacyRunner.onFps = (fps) => {
      fpsValue.textContent = fps.toFixed(0);
    };
    legacyRunner.onError = reportError;
    legacyRunner.start();
  } catch (e2) {
    errorBanner.classList.add("visible");
    errorBanner.textContent = String(e2);
  }
}

function resizeCanvas(): void {
  const rect = viewportFrame.getBoundingClientRect();
  mpRunner?.resize(rect.width, rect.height || 440);
  legacyRunner?.resize(rect.width, rect.height || 440);
  resValue.textContent = `${canvas.width}×${canvas.height}`;
  if (mpSourceRunner || legacySourceRunner) {
    const srcRect = frameSource.getBoundingClientRect();
    mpSourceRunner?.resize(srcRect.width, srcRect.height || 440);
    legacySourceRunner?.resize(srcRect.width, srcRect.height || 440);
  }
}
window.addEventListener("resize", resizeCanvas);

// ---------------------------------------------------------------------
// Tab mode (narrow viewports): only one of the 3 top-level panels is
// shown at a time, switched via `#tab-bar` (hidden by CSS on wide
// desktop layouts). Not to be confused with the buffer tabs above.
// ---------------------------------------------------------------------
const tabPanels: Record<string, HTMLElement> = {
  source: panelSource,
  golfed: panelGolfed,
  viewport: panelViewport,
};

function setActiveTab(name: string): void {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  Object.entries(tabPanels).forEach(([key, el]) => el.classList.toggle("active-tab", key === name));
  resizeCanvas();
}
tabButtons.forEach((b) => b.addEventListener("click", () => setActiveTab(b.dataset.tab!)));

// ---------------------------------------------------------------------
// Resizable columns (desktop 3-column layout only — hidden by CSS in
// tab mode).
// ---------------------------------------------------------------------
const COLUMN_STORAGE_KEY = "glslgolf-columns";
const MIN_COLUMN_WIDTH = 240;

function loadColumnWidths(): [number, number] {
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && typeof parsed[0] === "number" && typeof parsed[1] === "number") {
        return [parsed[0], parsed[1]];
      }
    }
  } catch {
    /* corrupt/unavailable storage — fall back to defaults below */
  }
  return [420, 420];
}

function saveColumnWidths(w1: number, w2: number): void {
  try {
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify([w1, w2]));
  } catch {
    /* storage unavailable (private mode, quota) — resizing still works, just not persisted */
  }
}

let [colW1, colW2] = loadColumnWidths();

function applyColumnWidths(): void {
  workspaceEl.style.setProperty("--w1", `${colW1}px`);
  workspaceEl.style.setProperty("--w2", `${colW2}px`);
}
applyColumnWidths();

function makeResizer(handle: HTMLElement, which: 1 | 2): void {
  let dragging = false;
  let startX = 0;
  let startW = 0;

  const setWidth = (v: number) => {
    const clamped = Math.max(MIN_COLUMN_WIDTH, v);
    if (which === 1) colW1 = clamped;
    else colW2 = clamped;
    applyColumnWidths();
  };

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = which === 1 ? colW1 : colW2;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    setWidth(startW + (e.clientX - startX));
  });
  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    saveColumnWidths(colW1, colW2);
    resizeCanvas();
  };
  handle.addEventListener("pointerup", stopDrag);
  handle.addEventListener("pointercancel", stopDrag);

  handle.addEventListener("keydown", (e) => {
    const step = 24;
    if (e.key === "ArrowLeft") {
      setWidth((which === 1 ? colW1 : colW2) - step);
    } else if (e.key === "ArrowRight") {
      setWidth((which === 1 ? colW1 : colW2) + step);
    } else {
      return;
    }
    e.preventDefault();
    saveColumnWidths(colW1, colW2);
    resizeCanvas();
  });
}
makeResizer(resizer1, 1);
makeResizer(resizer2, 2);

// ---------------------------------------------------------------------
// Aggressive-passes popover.
// ---------------------------------------------------------------------
function closePopover(): void {
  passesPopover.hidden = true;
  passesBtn.setAttribute("aria-expanded", "false");
}
function openPopover(): void {
  const rect = passesBtn.getBoundingClientRect();
  passesPopover.style.left = `${rect.left}px`;
  passesPopover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  passesPopover.hidden = false;
  passesBtn.setAttribute("aria-expanded", "true");
}
passesBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (passesPopover.hidden) openPopover();
  else closePopover();
});
passesPopover.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", closePopover);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopover();
  // Ctrl/Cmd+Enter runs the golfer from anywhere, including while the
  // CodeMirror editor has focus — this isn't a key CodeMirror binds by
  // default, so it bubbles to this document-level listener normally.
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    golfProject();
  }
});
window.addEventListener("resize", closePopover);

// Comparison mode: a second, independent runner rendering the *un-
// golfed* project side-by-side with the golfed one.
function setCompareMode(on: boolean): void {
  frameSource.hidden = !on;
  labelGolfed.hidden = !on;
  if (on && !mpSourceRunner && !legacySourceRunner) {
    try {
      if (compatMode.active) {
        legacySourceRunner = new ShaderRunner(canvasSource);
        legacySourceRunner.start();
      } else {
        mpSourceRunner = new MultiPassRunner(canvasSource);
        mpSourceRunner.start();
      }
    } catch (e) {
      console.warn("comparison viewport unavailable:", e);
      frameSource.hidden = true;
      labelGolfed.hidden = true;
      compareToggle.checked = false;
      return;
    }
  }
  resizeCanvas();
}
compareToggle.addEventListener("change", () => setCompareMode(compareToggle.checked));

function currentAggressiveOptions(): AggressiveOptions {
  return {
    eliminateDeadLocals: passDeadLocals.checked,
    eliminateDeadStores: passDeadStores.checked,
    foldConstants: passFoldConstants.checked,
    reduceConstantVectors: passConstantVectors.checked,
    stripTrailingVoidReturn: passTrailingReturn.checked,
    compoundAssignments: passCompound.checked,
    incrementDecrement: passIncDec.checked,
    ternaryFromIfElse: passTernary.checked,
    mergeDeclarations: passMerge.checked,
    stripRedundantBraces: passBraces.checked,
  };
}

/** Keeps the master "Golf agressif" checkbox in sync with the 6 individual passes. */
/** Ticks the checkboxes belonging to `level`'s preset, clearing every other one. */
function applyGolfLevel(level: GolfLevel): void {
  const on = new Set(GOLF_LEVEL_PASSES[level]);
  passCheckboxes.forEach((cb) => (cb.checked = on.has(cb)));
  golfLevelSelect.value = level;
}

/**
 * Keeps the level dropdown in sync with the 10 individual pass
 * checkboxes: if their current combination matches a preset exactly,
 * shows that preset; otherwise falls onto the hidden "custom" option
 * (present in the DOM but not offered as a manual choice) — the
 * `<select>` equivalent of the old master checkbox's `.indeterminate`
 * state for the boolean toggle this replaced.
 */
function syncGolfLevelSelect(): void {
  const checkedSet = new Set(passCheckboxes.filter((cb) => cb.checked));
  const match = (Object.keys(GOLF_LEVEL_PASSES) as GolfLevel[]).find((level) => {
    const preset = GOLF_LEVEL_PASSES[level];
    return preset.length === checkedSet.size && preset.every((cb) => checkedSet.has(cb));
  });
  golfLevelSelect.value = match ?? "custom";
}

let lastResults: Partial<Record<Exclude<BufferId, "common">, GolfResult>> = {};

/** Renders the currently selected tab's golfed code into the read-only editor, reformatted if "Version justifiée" is checked. */
function renderOutput(): void {
  if (currentTab === "common") {
    setEditorContent(outputEditor, t("output.commonPlaceholder"));
    return;
  }
  const result = lastResults[currentTab as Exclude<BufferId, "common">];
  if (!result) {
    setEditorContent(outputEditor, t("output.placeholder"));
    return;
  }
  setEditorContent(outputEditor, prettyToggle.checked ? prettyPrintGolfed(result.code) : result.code);
}

// ---------------------------------------------------------------------
// Competition size-class badges — a handful of well-known GLSL golf/
// demoscene byte budgets (Twitter shaders, 1k/4k/8k intros), each shown
// with a checkmark once the golfed output actually fits under it.
// Compares against the same UTF-8 byte count as the "octets golfés"
// stat, summed across every active buffer/pass.
// ---------------------------------------------------------------------
const SIZE_CLASSES: { bytes: number; label: string }[] = [
  { bytes: 280, label: "280B" },
  { bytes: 512, label: "512B" },
  { bytes: 1024, label: "1k" },
  { bytes: 4096, label: "4k" },
  { bytes: 8192, label: "8k" },
];

let lastTotalOutBytes = 0;

function renderSizeBadges(totalBytes: number): void {
  lastTotalOutBytes = totalBytes;
  sizeBadges.innerHTML = SIZE_CLASSES.map((cls) => {
    const fits = totalBytes <= cls.bytes;
    const title = fits
      ? t("sizeBadge.fits", { label: cls.label, limit: String(cls.bytes) })
      : t("sizeBadge.tooBig", { label: cls.label, limit: String(cls.bytes), over: String(totalBytes - cls.bytes) });
    return `<span class="size-badge${fits ? " fits" : ""}" title="${title}">${fits ? "✓" : "✗"} ${cls.label}</span>`;
  }).join("");
}

/** Recomputed on every golf run *and* on language switch (so an already-visible warning re-translates instead of staying stale). */
function updateLegacyWarnings(): void {
  const legacyWarnings = compilablePasses()
    .map((p) => {
      const fns = detectLegacyGlslFunctions(common + "\n" + p.state.code);
      return fns.length > 0 ? t("warning.versionMismatch", { pass: BUFFER_LABELS[p.id], funcs: fns.join(", ") }) : null;
    })
    .filter((w): w is string => w !== null);
  warningBanner.hidden = legacyWarnings.length === 0;
  warningBanner.textContent = legacyWarnings.join("\n");
}

function currentProtectedNames(): string[] {
  return protectedNamesInput.value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function golfProject(): void {
  const options = currentAggressiveOptions();
  const protectedNames = currentProtectedNames();
  const passes = compilablePasses();
  lastResults = {};
  for (const p of passes) {
    lastResults[p.id] = golfImpl(common + "\n" + p.state.code, options, protectedNames);
  }
  renderOutput();
  updateLegacyWarnings();

  const totalIn = passes.reduce((s, p) => s + lastResults[p.id]!.stats.inputChars, 0);
  const totalOut = passes.reduce((s, p) => s + lastResults[p.id]!.stats.outputChars, 0);
  const totalOutBytes = passes.reduce((s, p) => s + new TextEncoder().encode(lastResults[p.id]!.code).length, 0);
  const totalRenamed = passes.reduce((s, p) => s + lastResults[p.id]!.stats.renamedCount, 0);
  const totalNumbers = passes.reduce((s, p) => s + lastResults[p.id]!.stats.numbersShortened, 0);
  cIn.textContent = String(totalIn);
  cOut.textContent = String(totalOut);
  cOutBytes.textContent = String(totalOutBytes);
  cRenamed.textContent = String(totalRenamed);
  cNumbers.textContent = String(totalNumbers);
  renderSizeBadges(totalOutBytes);

  aggressiveStatsRow.hidden = !Object.values(options).some(Boolean);
  const sumAgg = (key: keyof GolfResult["stats"]["aggressive"]) =>
    passes.reduce((s, p) => s + (lastResults[p.id]!.stats.aggressive[key] as number), 0);
  cDead.textContent = String(sumAgg("deadLocalsRemoved"));
  cStores.textContent = String(sumAgg("deadStoresRemoved"));
  cFolded.textContent = String(sumAgg("constantsFolded"));
  cVectors.textContent = String(sumAgg("constantVectorsReduced"));
  cCompound.textContent = String(sumAgg("compoundAssignments"));
  cIncDec.textContent = String(sumAgg("incrementsDecrements"));
  cTernary.textContent = String(sumAgg("ternariesFromIfElse"));
  cMerged.textContent = String(sumAgg("declarationsMerged"));
  cBraces.textContent = String(sumAgg("bracesRemoved"));
  cTrailingReturn.textContent = String(sumAgg("trailingVoidReturnsRemoved"));

  perPassStats.innerHTML = passes
    .map((p) => {
      const r = lastResults[p.id]!;
      const pct = r.stats.inputChars === 0 ? 0 : ((r.stats.inputChars - r.stats.outputChars) / r.stats.inputChars) * 100;
      return `<span>${BUFFER_LABELS[p.id]} : <b>${r.stats.inputChars}</b>→<b>${r.stats.outputChars}</b> (${pct.toFixed(0)}%)</span>`;
    })
    .join("");

  const pct = totalIn === 0 ? 0 : Math.max(0, Math.min(100, ((totalIn - totalOut) / totalIn) * 100));
  ratioValue.textContent = `${pct.toFixed(1)}%`;
  const litCount = Math.round((pct / 100) * TICK_COUNT);
  Array.from(ticks.children).forEach((el, i) => {
    el.classList.toggle("lit", i < litCount);
  });

  const golfedPassSources: PassSource[] = passes.map((p) => ({
    id: p.id as PassId,
    code: lastResults[p.id]!.code,
    channels: p.state.channels,
  }));
  const rawPassSources: PassSource[] = passes.map((p) => ({
    id: p.id as PassId,
    code: common + "\n" + p.state.code,
    channels: p.state.channels,
  }));

  let golfedOk: boolean;
  if (compatMode.active) {
    const imageGolfed = lastResults["image"];
    golfedOk = legacyRunner?.load(imageGolfed?.code ?? "") ?? true;
    if (activeSlots().length > 0) {
      errorBanner.classList.add("visible");
      errorBanner.textContent = (errorBanner.textContent ? errorBanner.textContent + "\n\n" : "") + t("error.webgl2Unavailable");
    }
  } else {
    golfedOk = mpRunner?.load(golfedPassSources) ?? true;
  }

  setErrorLineHighlight(sourceEditor, null);
  if (!golfedOk && !compatMode.active && mpRunner) {
    const sourceErr = mpRunner.tryCompile(rawPassSources);
    const note = sourceErr ? t("error.sourceAlsoBroken") : t("error.golfBrokeIt");
    errorBanner.textContent = (errorBanner.textContent ?? "") + note;
    // Unlike the golfed-output highlight above, source is genuinely
    // multi-line user-authored code — this is where a line number is
    // actually informative rather than "line 1" almost every time.
    if (sourceErr) {
      const failingTab: BufferId = "passId" in sourceErr ? (sourceErr.passId as BufferId) : "image";
      if (failingTab !== currentTab) switchTab(failingTab);
      const wrappedLine = computeErrorLine(sourceErr);
      const sourceLine = wrappedLine !== null ? wrappedLine - commonPrefixLineCount() : null;
      setErrorLineHighlight(sourceEditor, sourceLine !== null && sourceLine >= 1 ? sourceLine : null);
    }
  }

  if (compatMode.active) legacySourceRunner?.load(common + "\n" + imageState.code);
  else mpSourceRunner?.load(rawPassSources);
  resizeCanvas();
}

runBtn.addEventListener("click", golfProject);
golfLevelSelect.addEventListener("change", () => {
  if (golfLevelSelect.value === "custom") return; // not a real user choice, just the sync target
  applyGolfLevel(golfLevelSelect.value as GolfLevel);
  golfProject();
});
passCheckboxes.forEach((cb) =>
  cb.addEventListener("change", () => {
    syncGolfLevelSelect();
    golfProject();
  }),
);
let protectedNamesTimer: ReturnType<typeof setTimeout> | undefined;
protectedNamesInput.addEventListener("input", () => {
  if (protectedNamesTimer !== undefined) clearTimeout(protectedNamesTimer);
  protectedNamesTimer = setTimeout(() => {
    golfProject();
    scheduleAutosave();
  }, 400);
});
resetBtn.addEventListener("click", () => {
  common = "";
  bufferStates = {};
  imageState = { code: DEFAULT_IMAGE_CODE, channels: emptyChannels() };
  protectedNamesInput.value = "";
  switchTab("image");
  golfProject();
});
prettyToggle.addEventListener("change", renderOutput);
copyBtn.addEventListener("click", async () => {
  const result = lastResults[currentTab as Exclude<BufferId, "common">];
  if (!result) return;
  try {
    await navigator.clipboard.writeText(result.code);
    const original = copyBtn.textContent;
    copyBtn.textContent = t("btn.copy.done");
    setTimeout(() => (copyBtn.textContent = original), 1200);
  } catch {
    /* clipboard permission denied — silently ignore, code is still visible/selectable */
  }
});

let paused = false;
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  mpRunner?.setPaused(paused);
  legacyRunner?.setPaused(paused);
  pauseBtn.textContent = paused ? "▶" : "⏸";
});

screenshotBtn.addEventListener("click", () => {
  // Captures whatever is currently in the canvas's drawing buffer --
  // works without `preserveDrawingBuffer` because `toBlob` runs
  // synchronously against the buffer's current contents, before the
  // next requestAnimationFrame draw call has a chance to touch it.
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, `glsl-golf-${Date.now()}.png`);
  }, "image/png");
});

let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
recordBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  recordedChunks = [];
  // 30fps is plenty for a shader preview clip and keeps the encoded
  // file small; the shader itself may render faster, but the capture
  // stream samples the canvas at this fixed rate regardless.
  const stream = canvas.captureStream(30);
  mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    downloadBlob(new Blob(recordedChunks, { type: "video/webm" }), `glsl-golf-${Date.now()}.webm`);
    recordBtn.textContent = "⏺";
    recordBtn.classList.remove("recording");
  };
  mediaRecorder.start();
  recordBtn.textContent = "⏹";
  recordBtn.classList.add("recording");
});

// ---------------------------------------------------------------------
// Shadertoy import/export.
//
// Import needs the caller's own free Shadertoy API key (shadertoy.com/
// myapps) — there's no way for this app to hold or share one. It's kept
// in localStorage after the first prompt. Only "buffer" channel inputs
// are reconstructed; texture/video/audio/webcam/cubemap/keyboard inputs
// are dropped with a note, since this app doesn't render those channel
// types yet (see ROADMAP.md). Shadertoy's API may also not send
// permissive CORS headers for browser-side fetches from a third-party
// origin like this one — if so, the fetch fails with a network error
// rather than a clean "wrong key" message; there's no client-side fix
// for that short of a server-side proxy.
// ---------------------------------------------------------------------
function extractShaderId(input: string): string | null {
  const trimmed = input.trim();
  const m = trimmed.match(/shadertoy\.com\/view\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{6}$/.test(trimmed)) return trimmed;
  return null;
}

interface ShadertoyInput {
  id: string;
  channel: number;
  type: string;
}
interface ShadertoyOutput {
  id: string;
  channel: number;
}
interface ShadertoyRenderpass {
  inputs: ShadertoyInput[];
  outputs: ShadertoyOutput[];
  code: string;
  name: string;
  type: string; // "image" | "buffer" | "common" | "sound" | "cubemap"
}
interface ShadertoyShader {
  renderpass: ShadertoyRenderpass[];
}

async function importFromShadertoy(): Promise<void> {
  const url = window.prompt(t("shadertoy.promptUrl"));
  if (!url) return;
  const id = extractShaderId(url);
  if (!id) {
    window.alert(t("shadertoy.idNotFound"));
    return;
  }
  let apiKey = localStorage.getItem("shadertoy-api-key");
  if (!apiKey) {
    apiKey = window.prompt(t("shadertoy.promptApiKey"));
    if (!apiKey) return;
    localStorage.setItem("shadertoy-api-key", apiKey);
  }
  try {
    const res = await fetch(`https://www.shadertoy.com/api/v1/shaders/${id}?key=${encodeURIComponent(apiKey)}`);
    const data = await res.json();
    if (data.Error) {
      window.alert(t("shadertoy.apiError") + data.Error);
      return;
    }
    applyShadertoyShader(data.Shader as ShadertoyShader);
  } catch (e) {
    window.alert(t("shadertoy.importFailed") + String(e) + t("shadertoy.corsNote"));
  }
}

function applyShadertoyShader(shader: ShadertoyShader): void {
  const outputIdToSlot = new Map<string, BufferSlot>();
  const bufferNameOrder: BufferSlot[] = ["bufferA", "bufferB", "bufferC", "bufferD"];
  let nextSlot = 0;
  for (const pass of shader.renderpass) {
    if (pass.type === "buffer" && pass.outputs[0] && nextSlot < bufferNameOrder.length) {
      outputIdToSlot.set(pass.outputs[0].id, bufferNameOrder[nextSlot]);
      nextSlot++;
    }
  }

  const unsupported: string[] = [];
  function wireChannels(inputs: ShadertoyInput[], passName: string): ChannelWiring[] {
    const channels = emptyChannels();
    for (const inp of inputs) {
      if (inp.type === "buffer" && outputIdToSlot.has(inp.id)) {
        channels[inp.channel] = { kind: "buffer", id: outputIdToSlot.get(inp.id)! };
      } else if (inp.type === "keyboard") {
        // Unlike texture/cubemap/video/audio, this needs no asset at
        // all -- both Shadertoy's and this app's keyboard channel are
        // just live keydown/keyup events, so this is a real, correct
        // import, not a placeholder substitution.
        channels[inp.channel] = { kind: "keyboard" };
      } else {
        unsupported.push(t("shadertoy.unsupportedChannel", { pass: passName, ch: String(inp.channel), type: inp.type }));
      }
    }
    return channels;
  }

  const newBufferStates: Partial<Record<BufferSlot, PassState>> = {};
  let newImage: PassState = { code: "", channels: emptyChannels() };
  let newCommon = "";
  for (const pass of shader.renderpass) {
    if (pass.type === "common") {
      newCommon = pass.code;
    } else if (pass.type === "image") {
      newImage = { code: pass.code, channels: wireChannels(pass.inputs, "Image") };
    } else if (pass.type === "buffer") {
      const slot = pass.outputs[0] ? outputIdToSlot.get(pass.outputs[0].id) : undefined;
      if (slot) newBufferStates[slot] = { code: pass.code, channels: wireChannels(pass.inputs, BUFFER_LABELS[slot]) };
    } else {
      unsupported.push(t("shadertoy.unsupportedPass", { name: pass.name, type: pass.type }));
    }
  }

  common = newCommon;
  bufferStates = newBufferStates;
  imageState = newImage;
  switchTab("image");
  golfProject();

  if (unsupported.length > 0) {
    window.alert(t("shadertoy.importLimitations") + unsupported.join("\n"));
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportToShadertoy(): void {
  const passes: ShadertoyRenderpass[] = [];
  if (common.trim()) {
    passes.push({ code: common, name: "Common", type: "common", inputs: [], outputs: [] });
  }
  // "keyboard" exports as real Shadertoy input, same reasoning as the
  // import side: it needs no asset, so this is a faithful round-trip,
  // not a placeholder. "cubemap"/"volume" are local-only synthetic
  // test textures with nothing real to reference on Shadertoy's side,
  // so (like "none") they're simply omitted -- silently, same as
  // they've always been.
  function channelToInput(ch: ChannelWiring, i: number): ShadertoyInput | null {
    if (ch.kind === "buffer") return { id: `367${activeSlots().indexOf(ch.id)}`, channel: i, type: "buffer" };
    if (ch.kind === "keyboard") return { id: "keyboard", channel: i, type: "keyboard" };
    return null;
  }

  let bufIdx = 0;
  for (const slot of activeSlots()) {
    const state = bufferStates[slot]!;
    passes.push({
      code: state.code,
      name: BUFFER_LABELS[slot],
      type: "buffer",
      outputs: [{ id: `367${bufIdx}`, channel: 0 }],
      inputs: state.channels.map(channelToInput).filter((x): x is ShadertoyInput => x !== null),
    });
    bufIdx++;
  }
  passes.push({
    code: imageState.code,
    name: "Image",
    type: "image",
    outputs: [{ id: "image", channel: 0 }],
    inputs: imageState.channels.map(channelToInput).filter((x): x is ShadertoyInput => x !== null),
  });

  const json = JSON.stringify({ Shader: { info: { name: "Exported from GLSL Hyper-Golfer" }, renderpass: passes } }, null, 2);
  downloadBlob(new Blob([json], { type: "application/json" }), "shadertoy-export.json");
}

importBtn.addEventListener("click", () => void importFromShadertoy());
exportBtn.addEventListener("click", exportToShadertoy);

applyTranslations();
setActiveTab("source");
resizeCanvas();
syncGolfLevelSelect();
wasmReady.finally(() => {
  engineLabelEl.textContent = engineLabel;
  golfProject();
});
