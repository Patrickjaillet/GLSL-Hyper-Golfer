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
        <h1 title="tokenizer-based GLSL minifier · WebGL2 live preview">Hyper-Golfing Engine</h1>
      </div>
      <nav class="tab-bar" id="tab-bar">
        <button class="tab-btn" data-tab="source" type="button">Source</button>
        <button class="tab-btn" data-tab="golfed" type="button">Golfé</button>
        <button class="tab-btn" data-tab="viewport" type="button">Viewport</button>
      </nav>
      <div class="engine-pill" title="moteur natif : tokenize → renommage → nombres → mise en page">
        <span class="dot cyan"></span>moteur actif : <b id="engine-label">…</b>
      </div>
    </header>

    <div class="workspace" id="workspace">
      <section class="panel active-tab" id="panel-source" data-panel="source">
        <div class="buffer-tabs" id="buffer-tabs"></div>
        <div class="channel-row" id="channel-row" hidden></div>
        <div class="editor">
          <div class="gutter" id="gutter"></div>
          <textarea id="source" spellcheck="false"></textarea>
        </div>
        <div class="actions">
          <label class="aggressive-toggle" title="Coche/décoche les 6 passes ci-dessous d'un coup. Chacune reste réglable individuellement — voir ROADMAP.md pour ce que chaque passe fait et ne fait pas.">
            <input type="checkbox" id="aggressive-toggle" />
            Golf agressif
          </label>
          <button class="btn ghost small" id="import-btn" type="button" title="Importer un projet multi-buffer depuis une URL Shadertoy (nécessite une clé API Shadertoy gratuite)">⇩ Shadertoy</button>
          <button class="btn ghost small" id="export-btn" type="button" title="Exporter le projet courant au format JSON Shadertoy">⇧ Export</button>
          <button class="btn ghost small" id="passes-btn" type="button" aria-haspopup="true" aria-expanded="false" title="Choisir individuellement les passes actives">⚙ Passes</button>
          <button class="btn ghost" id="reset-btn" type="button">Réinitialiser</button>
          <button class="btn primary" id="run-btn" type="button">Exécuter le golfing</button>
        </div>
      </section>

      <div class="resizer" id="resizer-1" tabindex="0" title="Glisser pour redimensionner (ou ← →)"></div>

      <section class="panel" id="panel-golfed" data-panel="golfed">
        <div class="panel-head">
          <div class="panel-title"><span class="dot cyan"></span>Golfé — <span id="golfed-tab-label">Image</span></div>
          <label class="pretty-toggle" title="Réaffiche le code golfé sur plusieurs lignes indentées pour la lecture, sans changer le résultat réel : ce qui est copié et ce qui tourne dans le viewport reste la version minifiée.">
            <input type="checkbox" id="pretty-toggle" />
            Version justifiée
          </label>
          <button class="btn copy" id="copy-btn" type="button">Copier</button>
        </div>
        <div class="output-code" id="output"><span class="placeholder">— exécutez le golfing pour voir le résultat —</span></div>

        <div class="meter-block">
          <div class="meter-row">
            <span class="meter-label">Réduction totale</span>
            <div class="meter-ticks" id="ticks"></div>
            <span class="meter-value" id="ratio-value">0%</span>
          </div>
          <div class="stat-strip">
            <span><b id="c-in">0</b> car. source</span>
            <span><b id="c-out">0</b> car. golfés</span>
            <span><b id="c-renamed">0</b> identifiants renommés</span>
            <span><b id="c-numbers">0</b> nombres raccourcis</span>
          </div>
          <div class="stat-strip" id="aggressive-stats" hidden>
            <span><b id="c-dead">0</b> locaux morts supprimés</span>
            <span><b id="c-stores">0</b> écritures mortes supprimées</span>
            <span><b id="c-folded">0</b> constantes repliées</span>
            <span><b id="c-compound">0</b> affectations composées</span>
            <span><b id="c-merged">0</b> déclarations fusionnées</span>
            <span><b id="c-braces">0</b> blocs d'accolades supprimés</span>
          </div>
          <div class="stat-strip" id="per-pass-stats"></div>
        </div>

        <div class="error-banner" id="error-banner"></div>
      </section>

      <div class="resizer" id="resizer-2" tabindex="0" title="Glisser pour redimensionner (ou ← →)"></div>

      <div class="viewport-wrap" id="panel-viewport" data-panel="viewport">
        <div class="panel-head">
          <div class="panel-title"><span class="dot cyan"></span>Viewport temps réel</div>
          <label class="compare-toggle" title="Rend le shader source (non golfé) et le shader golfé côte-à-côte, pour repérer une différence visuelle silencieuse — le cas le plus dangereux : ça compile, mais le rendu a changé.">
            <input type="checkbox" id="compare-toggle" />
            Comparer
          </label>
        </div>
        <div class="viewport-split">
          <div class="viewport-frame" id="frame-source" hidden>
            <div class="viewport-label">source</div>
            <canvas id="glcanvas-source"></canvas>
          </div>
          <div class="viewport-frame" id="frame-golfed">
            <div class="viewport-label" id="label-golfed" hidden>golfé</div>
            <canvas id="glcanvas"></canvas>
            <div class="viewport-hud">
              <span class="fps"><b id="fps-value">--</b> fps</span>
              <span id="res-value">--×--</span>
            </div>
            <div class="viewport-controls">
              <button class="icon-btn" id="pause-btn" type="button" title="Pause / reprendre">⏸</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="passes-popover" id="passes-popover" hidden>
      <label title="Supprime une déclaration locale dont le nom n'apparaît nulle part ailleurs dans le fichier.">
        <input type="checkbox" id="pass-dead-locals" checked />locaux morts
      </label>
      <label title="Supprime une écriture immédiatement écrasée par la suivante, sans lecture entre les deux (x=1.;x=2.; → x=2.;).">
        <input type="checkbox" id="pass-dead-stores" checked />écritures mortes
      </label>
      <label title="Replie les opérations *, / et % entre littéraux entiers purs (2*3 → 6).">
        <input type="checkbox" id="pass-fold-constants" checked />constantes
      </label>
      <label title="Réécrit a=a+b en a+=b quand le membre droit est un terme unique.">
        <input type="checkbox" id="pass-compound" checked />affectations composées
      </label>
      <label title="Fusionne des déclarations contiguës de même type (float a=1.;float b=2.; → float a=1.,b=2.;).">
        <input type="checkbox" id="pass-merge" checked />fusion déclarations
      </label>
      <label title="Supprime les accolades d'un bloc à instruction unique, protégé contre le dangling-else.">
        <input type="checkbox" id="pass-braces" checked />accolades
      </label>
    </div>
  </div>
`;

const source = document.getElementById("source") as HTMLTextAreaElement;
const gutter = document.getElementById("gutter")!;
const bufferTabsEl = document.getElementById("buffer-tabs")!;
const channelRowEl = document.getElementById("channel-row") as HTMLElement;
const output = document.getElementById("output")!;
const golfedTabLabel = document.getElementById("golfed-tab-label")!;
const ticks = document.getElementById("ticks")!;
const ratioValue = document.getElementById("ratio-value")!;
const cIn = document.getElementById("c-in")!;
const cOut = document.getElementById("c-out")!;
const cRenamed = document.getElementById("c-renamed")!;
const cNumbers = document.getElementById("c-numbers")!;
const aggressiveStatsRow = document.getElementById("aggressive-stats")!;
const cDead = document.getElementById("c-dead")!;
const cStores = document.getElementById("c-stores")!;
const cFolded = document.getElementById("c-folded")!;
const cCompound = document.getElementById("c-compound")!;
const cBraces = document.getElementById("c-braces")!;
const cMerged = document.getElementById("c-merged")!;
const perPassStats = document.getElementById("per-pass-stats")!;
const aggressiveToggle = document.getElementById("aggressive-toggle") as HTMLInputElement;
const passDeadLocals = document.getElementById("pass-dead-locals") as HTMLInputElement;
const passDeadStores = document.getElementById("pass-dead-stores") as HTMLInputElement;
const passFoldConstants = document.getElementById("pass-fold-constants") as HTMLInputElement;
const passCompound = document.getElementById("pass-compound") as HTMLInputElement;
const passMerge = document.getElementById("pass-merge") as HTMLInputElement;
const passBraces = document.getElementById("pass-braces") as HTMLInputElement;
const passCheckboxes = [passDeadLocals, passDeadStores, passFoldConstants, passCompound, passMerge, passBraces];
const passesBtn = document.getElementById("passes-btn") as HTMLButtonElement;
const passesPopover = document.getElementById("passes-popover") as HTMLElement;
const importBtn = document.getElementById("import-btn") as HTMLButtonElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
const engineLabelEl = document.getElementById("engine-label")!;
const errorBanner = document.getElementById("error-banner")!;
const runBtn = document.getElementById("run-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement;
const prettyToggle = document.getElementById("pretty-toggle") as HTMLInputElement;
const pauseBtn = document.getElementById("pause-btn") as HTMLButtonElement;
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

const TICK_COUNT = 24;
for (let i = 0; i < TICK_COUNT; i++) {
  const t = document.createElement("div");
  t.className = "tick";
  ticks.appendChild(t);
}

function syncGutter(): void {
  const lineCount = source.value.split("\n").length;
  const rows: string[] = [];
  for (let i = 1; i <= lineCount; i++) rows.push(`<div>${i}</div>`);
  gutter.innerHTML = rows.join("");
  gutter.scrollTop = source.scrollTop;
}

/**
 * Purely cosmetic re-indentation of already-golfed code for the "Version
 * justifiée" display toggle — breaks the one-liner back onto multiple
 * indented lines after `;`/`{`/`}` so it reads like normal code. Never
 * touches the actual golfed string: what gets compiled and what gets
 * copied always stay the true minified output, this only changes what
 * `output.textContent` shows.
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

source.addEventListener("input", () => {
  setCurrentCode(source.value);
  syncGutter();
});
source.addEventListener("scroll", () => {
  gutter.scrollTop = source.scrollTop;
});

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
      const opts = [`<option value="none"${ch.kind === "none" ? " selected" : ""}>aucune</option>`]
        .concat(
          options
            .filter((slot) => slot !== currentTab || true) // self-reference (feedback) is allowed
            .map(
              (slot) =>
                `<option value="${slot}"${ch.kind === "buffer" && ch.id === slot ? " selected" : ""}>${BUFFER_LABELS[slot]}</option>`,
            ),
        )
        .join("");
      return `<label>iChannel${i} <select data-channel-index="${i}">${opts}</select></label>`;
    })
    .join("");
  channelRowEl.querySelectorAll<HTMLSelectElement>("select[data-channel-index]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const idx = Number(sel.dataset.channelIndex);
      const wiring: ChannelWiring = sel.value === "none" ? { kind: "none" } : { kind: "buffer", id: sel.value as BufferSlot };
      (getPassState(currentTab) as PassState).channels[idx] = wiring;
    });
  });
}

function renderBufferTabs(): void {
  const tabs = allTabs();
  bufferTabsEl.innerHTML =
    tabs
      .map((id) => {
        const removable = BUFFER_SLOTS.includes(id as BufferSlot);
        const closeBtn = removable ? `<span class="buffer-tab-close" data-remove="${id}" title="Retirer ce buffer">✕</span>` : "";
        return `<button class="buffer-tab-btn${id === currentTab ? " active" : ""}" data-buffer-tab="${id}" type="button">${BUFFER_LABELS[id]}${closeBtn}</button>`;
      })
      .join("") +
    (activeSlots().length < BUFFER_SLOTS.length
      ? `<button class="buffer-tab-add" id="add-buffer-btn" type="button" title="Ajouter un buffer">+ Buffer</button>`
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
  });
  const addBtn = document.getElementById("add-buffer-btn");
  addBtn?.addEventListener("click", addBuffer);
}

function switchTab(id: BufferId): void {
  currentTab = id;
  source.value = getPassState(id).code;
  syncGutter();
  renderBufferTabs();
  renderChannelRow();
  golfedTabLabel.textContent = BUFFER_LABELS[id];
  renderOutput();
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

function reportError(err: RenderError | MultiPassError | null): void {
  if (!err) {
    errorBanner.classList.remove("visible");
    errorBanner.textContent = "";
    return;
  }
  errorBanner.classList.add("visible");
  const passLabel = "passId" in err ? `${BUFFER_LABELS[err.passId as BufferId]} / ${err.stage}` : err.stage;
  errorBanner.textContent = `Erreur de compilation (${passLabel}) :\n${err.log}`;
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
    compoundAssignments: passCompound.checked,
    mergeDeclarations: passMerge.checked,
    stripRedundantBraces: passBraces.checked,
  };
}

/** Keeps the master "Golf agressif" checkbox in sync with the 6 individual passes. */
function syncMasterToggle(): void {
  const states = passCheckboxes.map((cb) => cb.checked);
  const allOn = states.every(Boolean);
  const anyOn = states.some(Boolean);
  aggressiveToggle.checked = allOn;
  aggressiveToggle.indeterminate = anyOn && !allOn;
}

let lastResults: Partial<Record<Exclude<BufferId, "common">, GolfResult>> = {};

/** Renders the currently selected tab's golfed code, reformatted if "Version justifiée" is checked. */
function renderOutput(): void {
  if (currentTab === "common") {
    output.innerHTML =
      '<span class="placeholder">— "Common" est fusionné dans chaque buffer/Image au golfing, il n\'a pas de sortie indépendante —</span>';
    return;
  }
  const result = lastResults[currentTab as Exclude<BufferId, "common">];
  if (!result) {
    output.innerHTML = '<span class="placeholder">— exécutez le golfing pour voir le résultat —</span>';
    return;
  }
  output.textContent = prettyToggle.checked ? prettyPrintGolfed(result.code) : result.code;
}

function golfProject(): void {
  const options = currentAggressiveOptions();
  const passes = compilablePasses();
  lastResults = {};
  for (const p of passes) {
    lastResults[p.id] = golfImpl(common + "\n" + p.state.code, options);
  }
  renderOutput();

  const totalIn = passes.reduce((s, p) => s + lastResults[p.id]!.stats.inputChars, 0);
  const totalOut = passes.reduce((s, p) => s + lastResults[p.id]!.stats.outputChars, 0);
  const totalRenamed = passes.reduce((s, p) => s + lastResults[p.id]!.stats.renamedCount, 0);
  const totalNumbers = passes.reduce((s, p) => s + lastResults[p.id]!.stats.numbersShortened, 0);
  cIn.textContent = String(totalIn);
  cOut.textContent = String(totalOut);
  cRenamed.textContent = String(totalRenamed);
  cNumbers.textContent = String(totalNumbers);

  aggressiveStatsRow.hidden = !Object.values(options).some(Boolean);
  const sumAgg = (key: keyof GolfResult["stats"]["aggressive"]) =>
    passes.reduce((s, p) => s + (lastResults[p.id]!.stats.aggressive[key] as number), 0);
  cDead.textContent = String(sumAgg("deadLocalsRemoved"));
  cStores.textContent = String(sumAgg("deadStoresRemoved"));
  cFolded.textContent = String(sumAgg("constantsFolded"));
  cCompound.textContent = String(sumAgg("compoundAssignments"));
  cMerged.textContent = String(sumAgg("declarationsMerged"));
  cBraces.textContent = String(sumAgg("bracesRemoved"));

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
      errorBanner.textContent =
        (errorBanner.textContent ? errorBanner.textContent + "\n\n" : "") +
        "WebGL2 indisponible sur ce navigateur : les buffers A-D ne peuvent pas être rendus (repli sur Image seul, tout iChannel qui leur est câblé lit du noir).";
    }
  } else {
    golfedOk = mpRunner?.load(golfedPassSources) ?? true;
  }

  if (!golfedOk && !compatMode.active && mpRunner) {
    const sourceErr = mpRunner.tryCompile(rawPassSources);
    const note = sourceErr
      ? "\n\n(Le projet source ne compile pas non plus — le golf n'y est pour rien.)"
      : "\n\n(Le projet source compile correctement : c'est le golf qui a cassé ce résultat — merci de signaler ce cas.)";
    errorBanner.textContent = (errorBanner.textContent ?? "") + note;
  }

  if (compatMode.active) legacySourceRunner?.load(common + "\n" + imageState.code);
  else mpSourceRunner?.load(rawPassSources);
  resizeCanvas();
}

runBtn.addEventListener("click", golfProject);
aggressiveToggle.addEventListener("change", () => {
  passCheckboxes.forEach((cb) => (cb.checked = aggressiveToggle.checked));
  aggressiveToggle.indeterminate = false;
  golfProject();
});
passCheckboxes.forEach((cb) =>
  cb.addEventListener("change", () => {
    syncMasterToggle();
    golfProject();
  }),
);
resetBtn.addEventListener("click", () => {
  common = "";
  bufferStates = {};
  imageState = { code: DEFAULT_IMAGE_CODE, channels: emptyChannels() };
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
    copyBtn.textContent = "Copié !";
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
  const url = window.prompt("URL ou ID Shadertoy (ex: https://www.shadertoy.com/view/XsXXDn) :");
  if (!url) return;
  const id = extractShaderId(url);
  if (!id) {
    window.alert("ID Shadertoy introuvable dans ce texte.");
    return;
  }
  let apiKey = localStorage.getItem("shadertoy-api-key");
  if (!apiKey) {
    apiKey = window.prompt("Clé API Shadertoy (gratuite — génère la tienne sur shadertoy.com/myapps) :");
    if (!apiKey) return;
    localStorage.setItem("shadertoy-api-key", apiKey);
  }
  try {
    const res = await fetch(`https://www.shadertoy.com/api/v1/shaders/${id}?key=${encodeURIComponent(apiKey)}`);
    const data = await res.json();
    if (data.Error) {
      window.alert("Erreur Shadertoy : " + data.Error);
      return;
    }
    applyShadertoyShader(data.Shader as ShadertoyShader);
  } catch (e) {
    window.alert(
      "Échec de l'import : " +
        String(e) +
        "\n\n(Si le message évoque CORS/réseau : l'API Shadertoy n'autorise peut-être pas les requêtes directes depuis ce site — pas de contournement possible côté navigateur.)",
    );
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
      } else {
        unsupported.push(`${passName} iChannel${inp.channel} : type "${inp.type}" non supporté, mis à "aucune".`);
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
      unsupported.push(`Passe "${pass.name}" de type "${pass.type}" non supportée (son/cubemap), ignorée.`);
    }
  }

  common = newCommon;
  bufferStates = newBufferStates;
  imageState = newImage;
  switchTab("image");
  golfProject();

  if (unsupported.length > 0) {
    window.alert("Import terminé avec des limitations :\n\n" + unsupported.join("\n"));
  }
}

function exportToShadertoy(): void {
  const passes: ShadertoyRenderpass[] = [];
  if (common.trim()) {
    passes.push({ code: common, name: "Common", type: "common", inputs: [], outputs: [] });
  }
  let bufIdx = 0;
  for (const slot of activeSlots()) {
    const state = bufferStates[slot]!;
    passes.push({
      code: state.code,
      name: BUFFER_LABELS[slot],
      type: "buffer",
      outputs: [{ id: `367${bufIdx}`, channel: 0 }],
      inputs: state.channels
        .map((ch, i) =>
          ch.kind === "buffer" ? { id: `367${activeSlots().indexOf(ch.id)}`, channel: i, type: "buffer" } : null,
        )
        .filter((x): x is ShadertoyInput => x !== null),
    });
    bufIdx++;
  }
  passes.push({
    code: imageState.code,
    name: "Image",
    type: "image",
    outputs: [{ id: "image", channel: 0 }],
    inputs: imageState.channels
      .map((ch, i) => (ch.kind === "buffer" ? { id: `367${activeSlots().indexOf(ch.id)}`, channel: i, type: "buffer" } : null))
      .filter((x): x is ShadertoyInput => x !== null),
  });

  const json = JSON.stringify({ Shader: { info: { name: "Exported from GLSL Hyper-Golfer" }, renderpass: passes } }, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "shadertoy-export.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

importBtn.addEventListener("click", () => void importFromShadertoy());
exportBtn.addEventListener("click", exportToShadertoy);

renderBufferTabs();
renderChannelRow();
source.value = getPassState(currentTab).code;
syncGutter();
setActiveTab("source");
resizeCanvas();
syncMasterToggle();
wasmReady.finally(() => {
  engineLabelEl.textContent = engineLabel;
  golfProject();
});
