/**
 * Minimal i18n layer — no framework, just a key→string lookup with a
 * `{placeholder}` substitution, because the whole UI was written as one
 * big template-literal string plus imperative DOM/alert() calls, not a
 * component framework with built-in re-rendering. Static chrome (built
 * once into the `app.innerHTML` template) is retranslated in place via
 * `data-i18n`/`data-i18n-title` attributes (see `applyTranslations()`
 * in main.ts); anything already rebuilt dynamically on every render
 * (buffer tabs, channel rows) picks up the new locale for free just by
 * calling `t()` again next time it re-renders.
 */
export type Locale = "fr" | "en";

type Dict = Record<string, string>;

const fr: Dict = {
  "app.tagline": "minifieur GLSL par tokenizer · aperçu WebGL2 en direct",
  "tab.source": "Source",
  "tab.golfed": "Golfé",
  "tab.viewport": "Viewport",
  "engine.tooltip": "moteur natif : tokenize → renommage → nombres → mise en page",
  "engine.activeLabel": "moteur actif : ",
  "panel.golfed.prefix": "Golfé — ",
  "panel.viewport.title": "Viewport temps réel",
  "toggle.aggressive.label": "Golf agressif",
  "toggle.aggressive.title":
    "Coche/décoche les 8 passes ci-dessous d'un coup. Chacune reste réglable individuellement — voir ROADMAP.md pour ce que chaque passe fait et ne fait pas.",
  "btn.import.title": "Importer un projet multi-buffer depuis une URL Shadertoy (nécessite une clé API Shadertoy gratuite)",
  "btn.export.title": "Exporter le projet courant au format JSON Shadertoy",
  "btn.passes.title": "Choisir individuellement les passes actives",
  "btn.reset": "Réinitialiser",
  "btn.run": "Exécuter le golfing",
  "btn.run.title": "Ctrl/Cmd+Entrée pour lancer depuis l'éditeur",
  "pause.ariaLabel": "Pause / reprendre la lecture",
  "buffer.add": "+ Buffer",
  "toggle.pretty.label": "Version justifiée",
  "toggle.pretty.title":
    "Réaffiche le code golfé sur plusieurs lignes indentées pour la lecture, sans changer le résultat réel : ce qui est copié et ce qui tourne dans le viewport reste la version minifiée.",
  "btn.copy": "Copier",
  "btn.copy.done": "Copié !",
  "output.placeholder": "— exécutez le golfing pour voir le résultat —",
  "output.commonPlaceholder": '— "Common" est fusionné dans chaque buffer/Image au golfing, il n\'a pas de sortie indépendante —',
  "meter.label": "Réduction totale",
  "stat.inputChars": "car. source",
  "stat.outputChars": "car. golfés",
  "stat.renamed": "identifiants renommés",
  "stat.numbers": "nombres raccourcis",
  "stat.outputBytes": "octets golfés (UTF-8)",
  "stat.deadLocals": "locaux morts supprimés",
  "stat.deadStores": "écritures mortes supprimées",
  "stat.folded": "constantes repliées",
  "stat.constantVectors": "vecteurs constants réduits",
  "stat.compound": "affectations composées",
  "stat.merged": "déclarations fusionnées",
  "stat.braces": "blocs d'accolades supprimés",
  "stat.trailingReturn": "return finaux supprimés",
  "toggle.compare.label": "Comparer",
  "toggle.compare.title":
    "Rend le shader source (non golfé) et le shader golfé côte-à-côte, pour repérer une différence visuelle silencieuse — le cas le plus dangereux : ça compile, mais le rendu a changé.",
  "viewport.label.source": "source",
  "viewport.label.golfed": "golfé",
  "pause.title": "Pause / reprendre",
  "pass.deadLocals.label": "locaux morts",
  "pass.deadLocals.title": "Supprime une déclaration locale dont le nom n'apparaît nulle part ailleurs dans le fichier.",
  "pass.deadStores.label": "écritures mortes",
  "pass.deadStores.title":
    "Supprime une écriture immédiatement écrasée par la suivante, sans lecture entre les deux (x=1.;x=2.; → x=2.;).",
  "pass.foldConstants.label": "constantes",
  "pass.foldConstants.title": "Replie les opérations *, / et % entre littéraux entiers purs (2*3 → 6).",
  "pass.constantVectors.label": "vecteurs constants",
  "pass.constantVectors.title":
    "Réduit vec2/vec3/vec4(x,x,...,x) à vec2/vec3/vec4(x) quand tous les arguments sont le même littéral numérique (diffusion garantie par la spec GLSL).",
  "pass.compound.label": "affectations composées",
  "pass.compound.title": "Réécrit a=a+b en a+=b quand le membre droit est un terme unique.",
  "pass.merge.label": "fusion déclarations",
  "pass.merge.title": "Fusionne des déclarations contiguës de même type (float a=1.;float b=2.; → float a=1.,b=2.;).",
  "pass.braces.label": "accolades",
  "pass.braces.title": "Supprime les accolades d'un bloc à instruction unique, protégé contre le dangling-else.",
  "pass.trailingReturn.label": "return finaux",
  "pass.trailingReturn.title":
    "Supprime un `return;` sans valeur quand c'est la toute dernière instruction d'une fonction void — équivalent à tomber en fin de fonction. Protégé contre le cas piège `if(x)return;` (corps non accolé d'un if).",
  "channel.none": "aucune",
  "buffer.remove.title": "Retirer ce buffer",
  "buffer.resizer.title": "Glisser pour redimensionner (ou ← →)",
  "error.compileError": "Erreur de compilation ({pass}) :\n{log}",
  "error.sourceAlsoBroken": "\n\n(Le projet source ne compile pas non plus — le golf n'y est pour rien.)",
  "error.golfBrokeIt":
    "\n\n(Le projet source compile correctement : c'est le golf qui a cassé ce résultat — merci de signaler ce cas.)",
  "error.webgl2Unavailable":
    "WebGL2 indisponible sur ce navigateur : les buffers A-D ne peuvent pas être rendus (repli sur Image seul, tout iChannel qui leur est câblé lit du noir).",
  "shadertoy.promptUrl": "URL ou ID Shadertoy (ex: https://www.shadertoy.com/view/XsXXDn) :",
  "shadertoy.idNotFound": "ID Shadertoy introuvable dans ce texte.",
  "shadertoy.promptApiKey": "Clé API Shadertoy (gratuite — génère la tienne sur shadertoy.com/myapps) :",
  "shadertoy.apiError": "Erreur Shadertoy : ",
  "shadertoy.importFailed": "Échec de l'import : ",
  "shadertoy.corsNote":
    "\n\n(Si le message évoque CORS/réseau : l'API Shadertoy n'autorise peut-être pas les requêtes directes depuis ce site — pas de contournement possible côté navigateur.)",
  "shadertoy.importLimitations": "Import terminé avec des limitations :\n\n",
  "shadertoy.unsupportedChannel": '{pass} iChannel{ch} : type "{type}" non supporté, mis à "aucune".',
  "shadertoy.unsupportedPass": 'Passe "{name}" de type "{type}" non supportée (son/cubemap), ignorée.',
  "lang.toggle.title": "Switch to English",
  "warning.versionMismatch":
    "{pass} utilise {funcs}, des fonctions GLSL ES 1.00 absentes du contexte WebGL2/ES 3.00 utilisé ici — remplace-les par texture()/textureProj()/etc. avant de golfer.",
};

const en: Dict = {
  "app.tagline": "tokenizer-based GLSL minifier · WebGL2 live preview",
  "tab.source": "Source",
  "tab.golfed": "Golfed",
  "tab.viewport": "Viewport",
  "engine.tooltip": "native engine: tokenize → rename → numbers → layout",
  "engine.activeLabel": "active engine: ",
  "panel.golfed.prefix": "Golfed — ",
  "panel.viewport.title": "Live viewport",
  "toggle.aggressive.label": "Aggressive golf",
  "toggle.aggressive.title":
    "Checks/unchecks all 8 passes below at once. Each stays individually toggleable — see ROADMAP.md for exactly what each pass does and doesn't do.",
  "btn.import.title": "Import a multi-buffer project from a Shadertoy URL (needs a free Shadertoy API key)",
  "btn.export.title": "Export the current project as Shadertoy JSON",
  "btn.passes.title": "Choose which passes are active individually",
  "btn.reset": "Reset",
  "btn.run": "Run golf",
  "btn.run.title": "Ctrl/Cmd+Enter to run from the editor",
  "pause.ariaLabel": "Pause / resume playback",
  "buffer.add": "+ Buffer",
  "toggle.pretty.label": "Formatted view",
  "toggle.pretty.title":
    "Re-displays the golfed code across multiple indented lines for readability, without changing the actual result: what gets copied and what runs in the viewport stays the minified version.",
  "btn.copy": "Copy",
  "btn.copy.done": "Copied!",
  "output.placeholder": "— run the golfer to see the result —",
  "output.commonPlaceholder": '— "Common" is merged into every buffer/Image before golfing, it has no output of its own —',
  "meter.label": "Total reduction",
  "stat.inputChars": "source chars",
  "stat.outputChars": "golfed chars",
  "stat.renamed": "identifiers renamed",
  "stat.numbers": "numbers shortened",
  "stat.outputBytes": "golfed bytes (UTF-8)",
  "stat.deadLocals": "dead locals removed",
  "stat.deadStores": "dead stores removed",
  "stat.folded": "constants folded",
  "stat.constantVectors": "constant vectors reduced",
  "stat.compound": "compound assignments",
  "stat.merged": "declarations merged",
  "stat.braces": "brace blocks removed",
  "stat.trailingReturn": "trailing returns removed",
  "toggle.compare.label": "Compare",
  "toggle.compare.title":
    "Renders the source (un-golfed) and golfed shaders side by side, to catch a silent visual difference — the most dangerous case: it compiles, but the render changed.",
  "viewport.label.source": "source",
  "viewport.label.golfed": "golfed",
  "pause.title": "Pause / resume",
  "pass.deadLocals.label": "dead locals",
  "pass.deadLocals.title": "Removes a local declaration whose name doesn't appear anywhere else in the file.",
  "pass.deadStores.label": "dead stores",
  "pass.deadStores.title":
    "Removes a write immediately overwritten by the next one, with no read in between (x=1.;x=2.; → x=2.;).",
  "pass.foldConstants.label": "constants",
  "pass.foldConstants.title": "Folds *, / and % operations between plain integer literals (2*3 → 6).",
  "pass.constantVectors.label": "constant vectors",
  "pass.constantVectors.title":
    "Reduces vec2/vec3/vec4(x,x,...,x) to vec2/vec3/vec4(x) when every argument is the same numeric literal (broadcast guaranteed by the GLSL spec).",
  "pass.compound.label": "compound assignments",
  "pass.compound.title": "Rewrites a=a+b as a+=b when the right-hand side is a single term.",
  "pass.merge.label": "merge declarations",
  "pass.merge.title": "Merges adjacent same-type declarations (float a=1.;float b=2.; → float a=1.,b=2.;).",
  "pass.braces.label": "braces",
  "pass.braces.title": "Strips braces off a single-statement block, guarded against dangling-else.",
  "pass.trailingReturn.label": "trailing returns",
  "pass.trailingReturn.title":
    "Removes a valueless `return;` when it's the very last statement of a void function — equivalent to falling off the end. Guarded against the `if(x)return;` trap (an unbraced if's own body).",
  "channel.none": "none",
  "buffer.remove.title": "Remove this buffer",
  "buffer.resizer.title": "Drag to resize (or ← →)",
  "error.compileError": "Compile error ({pass}):\n{log}",
  "error.sourceAlsoBroken": "\n\n(The source project doesn't compile either — golfing isn't at fault.)",
  "error.golfBrokeIt": "\n\n(The source project compiles fine: golfing broke this result — please report this case.)",
  "error.webgl2Unavailable":
    "WebGL2 unavailable in this browser: buffers A-D can't be rendered (falling back to Image only — any iChannel wired to them reads black).",
  "shadertoy.promptUrl": "Shadertoy URL or ID (e.g. https://www.shadertoy.com/view/XsXXDn):",
  "shadertoy.idNotFound": "No Shadertoy ID found in that text.",
  "shadertoy.promptApiKey": "Shadertoy API key (free — generate your own at shadertoy.com/myapps):",
  "shadertoy.apiError": "Shadertoy error: ",
  "shadertoy.importFailed": "Import failed: ",
  "shadertoy.corsNote":
    "\n\n(If the message mentions CORS/network: Shadertoy's API may not allow direct requests from this site — there's no client-side workaround for that.)",
  "shadertoy.importLimitations": "Import finished with limitations:\n\n",
  "shadertoy.unsupportedChannel": '{pass} iChannel{ch}: type "{type}" not supported, set to "none".',
  "shadertoy.unsupportedPass": 'Pass "{name}" of type "{type}" not supported (sound/cubemap), skipped.',
  "lang.toggle.title": "Passer en français",
  "warning.versionMismatch":
    "{pass} uses {funcs}, GLSL ES 1.00 function(s) missing from the WebGL2/ES 3.00 context used here — replace with texture()/textureProj()/etc. before golfing.",
};

const DICTS: Record<Locale, Dict> = { fr, en };
const STORAGE_KEY = "glslgolf-locale";

function detectDefaultLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "fr" || saved === "en") return saved;
  } catch {
    /* storage unavailable — fall through to browser language detection */
  }
  return navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

let currentLocale: Locale = detectDefaultLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* storage unavailable — locale choice just won't survive a reload */
  }
  listeners.forEach((fn) => fn());
}

/** Called after every locale change — used to re-run `applyTranslations()` in main.ts. */
export function onLocaleChange(fn: () => void): void {
  listeners.add(fn);
}

export function t(key: string, vars?: Record<string, string>): string {
  let str = DICTS[currentLocale][key] ?? DICTS.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) str = str.split(`{${k}}`).join(v);
  }
  return str;
}
