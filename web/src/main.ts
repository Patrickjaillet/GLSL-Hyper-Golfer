import { golf, type AggressiveOptions } from "./golfer";
import { ShaderRunner, type RenderError } from "./renderer";
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

const DEFAULT_SHADER = `void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    // Normalized pixel coordinates (from 0 to 1)
    vec2 uv = fragCoord/iResolution.xy;

    // Time varying pixel color
    vec3 col = 0.5 + 0.5*cos(iTime+uv.xyx+vec3(0,2,4));

    // Output to screen
    fragColor = vec4(col,1.0);
}`;

// ---------------------------------------------------------------------
// Layout: a fixed-viewport "no scroll" dashboard (see ROADMAP-UI.md).
// Three columns (source / golfé / viewport) sit side by side inside
// `#workspace`, resizable via the two `.resizer` handles, and collapse
// into a single-panel tab view under a width/height breakpoint (CSS
// media query in style.css) — `#tab-bar` is only visible in that mode.
// ---------------------------------------------------------------------
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
        <div class="panel-head">
          <div class="panel-title"><span class="dot amber"></span>Source (déroulé)</div>
        </div>
        <div class="editor">
          <div class="gutter" id="gutter"></div>
          <textarea id="source" spellcheck="false"></textarea>
        </div>
        <div class="actions">
          <label class="aggressive-toggle" title="Coche/décoche les 6 passes ci-dessous d'un coup. Chacune reste réglable individuellement — voir ROADMAP.md pour ce que chaque passe fait et ne fait pas.">
            <input type="checkbox" id="aggressive-toggle" />
            Golf agressif
          </label>
          <button class="btn ghost small" id="passes-btn" type="button" aria-haspopup="true" aria-expanded="false" title="Choisir individuellement les passes actives">⚙ Passes</button>
          <button class="btn ghost" id="reset-btn" type="button">Réinitialiser</button>
          <button class="btn primary" id="run-btn" type="button">Exécuter le golfing</button>
        </div>
      </section>

      <div class="resizer" id="resizer-1" tabindex="0" title="Glisser pour redimensionner (ou ← →)"></div>

      <section class="panel" id="panel-golfed" data-panel="golfed">
        <div class="panel-head">
          <div class="panel-title"><span class="dot cyan"></span>Golfé (validé au rendu)</div>
          <label class="pretty-toggle" title="Réaffiche le code golfé sur plusieurs lignes indentées pour la lecture, sans changer le résultat réel : ce qui est copié et ce qui est rendu dans le viewport restent la version minifiée telle quelle.">
            <input type="checkbox" id="pretty-toggle" />
            Version justifiée
          </label>
          <button class="btn copy" id="copy-btn" type="button">Copier</button>
        </div>
        <div class="output-code" id="output"><span class="placeholder">— exécutez le golfing pour voir le résultat —</span></div>

        <div class="meter-block">
          <div class="meter-row">
            <span class="meter-label">Réduction</span>
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
const output = document.getElementById("output")!;
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
 * touches the actual golfed string: what gets compiled (`runner.load`)
 * and what gets copied (`copyBtn`) always stay the true minified output,
 * this only changes what `output.textContent` shows.
 *
 * Brace/paren tracking is enough here (not a full parser) because the
 * input is guaranteed well-formed GLSL already produced by the golfer —
 * this isn't re-validating syntax, just re-inserting the whitespace the
 * golfer stripped. `parenDepth` guards `for(a;b;c)` headers so the `;`
 * inside them doesn't break the line.
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

source.addEventListener("input", syncGutter);
source.addEventListener("scroll", () => {
  gutter.scrollTop = source.scrollTop;
});

let runner: ShaderRunner | null = null;
try {
  runner = new ShaderRunner(canvas);
  runner.onFps = (fps) => {
    fpsValue.textContent = fps.toFixed(0);
  };
  runner.onError = (err: RenderError | null) => {
    if (!err) {
      errorBanner.classList.remove("visible");
      errorBanner.textContent = "";
      return;
    }
    errorBanner.classList.add("visible");
    errorBanner.textContent = `Erreur de compilation (${err.stage}) :\n${err.log}`;
  };
  runner.start();
} catch (e) {
  errorBanner.classList.add("visible");
  errorBanner.textContent = String(e);
}

function resizeCanvas(): void {
  const rect = viewportFrame.getBoundingClientRect();
  runner?.resize(rect.width, rect.height || 440);
  resValue.textContent = `${canvas.width}×${canvas.height}`;
  if (sourceRunner) {
    const srcRect = frameSource.getBoundingClientRect();
    sourceRunner.resize(srcRect.width, srcRect.height || 440);
  }
}
window.addEventListener("resize", resizeCanvas);

// ---------------------------------------------------------------------
// Tab mode (narrow viewports): only one of the 3 panels is shown at a
// time, switched via `#tab-bar` (hidden by CSS on wide desktop layouts,
// where all 3 panels are visible simultaneously side by side — see the
// "no scroll" layout in style.css / ROADMAP-UI.md). `.active-tab` is
// what CSS keys off under the narrow-viewport media query; harmless to
// toggle even when that media query isn't active.
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
// tab mode). Widths are pixel-based for the source/golfé columns; the
// viewport column always takes the remaining space (`1fr`), so it never
// gets crushed to 0 by an overzealous drag. Persisted to localStorage so
// a chosen layout survives a reload.
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
// Aggressive-passes popover — replaces the old inline <details> block,
// which used to push the "Exécuter le golfing" button down whenever it
// was opened (bad in a fixed-height, no-scroll layout with a limited
// vertical budget). `position: fixed` (see style.css) lets it escape
// `.panel`'s `overflow: hidden` instead of getting clipped.
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

// Comparison mode: a second, independent ShaderRunner rendering the
// *un-golfed* source side-by-side with the golfed one — the only way
// this app can catch the most dangerous failure mode of a structural
// golf pass: it compiles fine, but silently renders something
// different. Created lazily on first use (skips opening a second WebGL
// context for users who never touch this) and left running afterwards
// rather than torn down, since toggling compare mode on and off
// repeatedly is the expected way to use it.
let sourceRunner: ShaderRunner | null = null;

function setCompareMode(on: boolean): void {
  frameSource.hidden = !on;
  labelGolfed.hidden = !on;
  if (on && !sourceRunner) {
    try {
      sourceRunner = new ShaderRunner(canvasSource);
      sourceRunner.start();
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

/** Keeps the master "Golf agressif" checkbox in sync with the 6 individual passes: checked only when all are on, indeterminate when some (but not all) are. */
function syncMasterToggle(): void {
  const states = passCheckboxes.map((cb) => cb.checked);
  const allOn = states.every(Boolean);
  const anyOn = states.some(Boolean);
  aggressiveToggle.checked = allOn;
  aggressiveToggle.indeterminate = anyOn && !allOn;
}

let lastGolfedCode = "";

/** Renders `lastGolfedCode` into the output panel, reformatted if "Version justifiée" is checked. Display-only — never touches `lastGolfedCode` itself. */
function renderOutput(): void {
  output.textContent = prettyToggle.checked ? prettyPrintGolfed(lastGolfedCode) : lastGolfedCode;
}

function runGolf(): void {
  const src = source.value;
  const options = currentAggressiveOptions();
  const result = golfImpl(src, options);

  lastGolfedCode = result.code;
  renderOutput();
  cIn.textContent = String(result.stats.inputChars);
  cOut.textContent = String(result.stats.outputChars);
  cRenamed.textContent = String(result.stats.renamedCount);
  cNumbers.textContent = String(result.stats.numbersShortened);

  aggressiveStatsRow.hidden = !Object.values(options).some(Boolean);
  cDead.textContent = String(result.stats.aggressive.deadLocalsRemoved);
  cStores.textContent = String(result.stats.aggressive.deadStoresRemoved);
  cFolded.textContent = String(result.stats.aggressive.constantsFolded);
  cCompound.textContent = String(result.stats.aggressive.compoundAssignments);
  cMerged.textContent = String(result.stats.aggressive.declarationsMerged);
  cBraces.textContent = String(result.stats.aggressive.bracesRemoved);

  const pct = Math.max(0, Math.min(100, result.stats.reductionPct));
  ratioValue.textContent = `${pct.toFixed(1)}%`;
  const litCount = Math.round((pct / 100) * TICK_COUNT);
  Array.from(ticks.children).forEach((el, i) => {
    el.classList.toggle("lit", i < litCount);
  });

  const golfedOk = runner?.load(result.code) ?? true;
  if (!golfedOk && runner) {
    // The golfed code failed — figure out whether the source was
    // already broken beforehand, so the banner doesn't leave the user
    // guessing whether it's their shader or the golfer's fault.
    const sourceErr = runner.tryCompile(src);
    const note = sourceErr
      ? "\n\n(Le shader source ne compile pas non plus — le golf n'y est pour rien.)"
      : "\n\n(Le shader source compile correctement : c'est le golf qui a cassé ce résultat — merci de signaler ce cas.)";
    errorBanner.textContent = (errorBanner.textContent ?? "") + note;
  }
  sourceRunner?.load(src);
  resizeCanvas();
}

runBtn.addEventListener("click", runGolf);
aggressiveToggle.addEventListener("change", () => {
  passCheckboxes.forEach((cb) => (cb.checked = aggressiveToggle.checked));
  aggressiveToggle.indeterminate = false;
  runGolf();
});
passCheckboxes.forEach((cb) =>
  cb.addEventListener("change", () => {
    syncMasterToggle();
    runGolf();
  }),
);
resetBtn.addEventListener("click", () => {
  source.value = DEFAULT_SHADER;
  syncGutter();
  runGolf();
});
prettyToggle.addEventListener("change", renderOutput);
copyBtn.addEventListener("click", async () => {
  // Always copies the true minified result, regardless of "Version
  // justifiée" — the toggle is a reading aid, not an alternate output.
  try {
    await navigator.clipboard.writeText(lastGolfedCode);
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
  runner?.setPaused(paused);
  pauseBtn.textContent = paused ? "▶" : "⏸";
});

source.value = DEFAULT_SHADER;
syncGutter();
setActiveTab("source");
resizeCanvas();
syncMasterToggle();
wasmReady.finally(() => {
  engineLabelEl.textContent = engineLabel;
  runGolf();
});
