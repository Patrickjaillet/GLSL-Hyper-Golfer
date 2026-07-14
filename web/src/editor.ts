/**
 * CodeMirror 6 setup shared by the Source (editable) and Golfé
 * (read-only) panels — replaces the old raw `<textarea>` + hand-synced
 * line-number `<div>` gutter with a real editor: syntax highlighting,
 * built-in gutter/folding, bracket matching, search, and basic
 * word-list autocompletion (see `glslLanguage.ts`).
 */
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { glsl } from "./glslLanguage";

const theme = EditorView.theme(
  {
    "&": {
      color: "var(--text-primary)",
      backgroundColor: "var(--bg-void)",
      height: "100%",
      fontSize: "var(--fs-3)",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      caretColor: "var(--acid-green)",
      padding: "10px 12px",
    },
    // Neon caret — a thin glow rather than a flat line, matching the
    // "curseur d'édition au style néon" ask (ROADMAP.md Phase 6).
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--acid-green)",
      borderLeftWidth: "2px",
      boxShadow: "0 0 4px var(--acid-green)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(57,255,136,0.18)",
    },
    ".cm-gutters": {
      // Slightly darker than the editor's own --bg-void (there's no
      // darker token in the palette to reference) so the gutter reads
      // as a distinct strip rather than blending into the content —
      // ROADMAP.md Phase 6 "fond légèrement plus sombre". var(--text-dim)
      // is the same secondary-text tone used everywhere else in the
      // app; it clears WCAG AA (4.5:1) against this background.
      backgroundColor: "#030405",
      color: "var(--text-dim)",
      border: "none",
      borderRight: "1px solid var(--line)",
    },
    ".cm-activeLineGutter": { backgroundColor: "rgba(57,255,136,0.08)", color: "var(--text-dim)" },
    // Active line reads as "selected line on an oscilloscope" — a faint
    // fill plus a thin neon accent bar down its left edge, not just a
    // barely-there background tint.
    ".cm-activeLine": {
      backgroundColor: "rgba(57,255,136,0.04)",
      boxShadow: "inset 2px 0 0 0 var(--acid-green)",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: "rgba(178,107,255,0.25)", outline: "none" },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-raised)",
      border: "1px solid var(--line)",
      color: "var(--text-primary)",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--fs-2)",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "var(--signal-violet)",
      color: "var(--bg-void)",
    },
    ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)" },
    "&.cm-editor.cm-focused": { outline: "none" },
    ".cm-error-line": { backgroundColor: "rgba(255, 59, 78, 0.18)" },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--signal-violet)" },
  { tag: [t.typeName, t.atom, t.bool], color: "#d9b8ff" },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: "#9fd6ff" },
  { tag: t.variableName, color: "var(--text-primary)" },
  { tag: t.number, color: "var(--amber-warn)" },
  { tag: t.string, color: "var(--acid-green)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--text-dim)", fontStyle: "italic" },
  { tag: t.operator, color: "var(--text-primary)" },
  { tag: [t.punctuation, t.bracket], color: "var(--text-dim)" },
  { tag: t.meta, color: "var(--line-glow)" },
  { tag: t.definition(t.variableName), color: "var(--text-primary)", fontWeight: "600" },
]);

// ---------------------------------------------------------------------
// Compile-error line highlight — set via `setErrorLineHighlight()` when
// a WebGL driver reports `ERROR: 0:N: ...` for code shown in this
// editor (see `renderer.ts`'s `bodyStartLine` and its use in main.ts),
// cleared on the next successful compile or edit.
// ---------------------------------------------------------------------
const setErrorLine = StateEffect.define<number | null>();

const errorLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) {
        if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) {
          deco = Decoration.none;
        } else {
          const line = tr.state.doc.line(e.value);
          deco = Decoration.set([Decoration.line({ attributes: { class: "cm-error-line" } }).range(line.from)]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Highlights `line1Indexed` (or clears the highlight if `null`/out of range). No-op extension needs to already be present — see `baseExtensions`. */
export function setErrorLineHighlight(view: EditorView, line1Indexed: number | null): void {
  view.dispatch({ effects: setErrorLine.of(line1Indexed) });
}

function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    foldGutter(),
    highlightSelectionMatches(),
    glsl(),
    syntaxHighlighting(highlightStyle),
    theme,
    errorLineField,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
  ];
}

/**
 * An axe-core audit flagged CodeMirror's content `<div>` as an ARIA
 * input field with no accessible name, and its scrollable container as
 * not reliably keyboard-focusable. Both editors go through this so
 * neither is easy to forget it on: `aria-label` names the field for
 * screen readers, and an explicit `tabIndex` guarantees the scroll
 * container has focusable content regardless of contenteditable state
 * (the read-only editor sets `contenteditable="false"`, which some
 * accessibility tooling doesn't treat as focusable by itself).
 */
function labelForA11y(view: EditorView, label: string): EditorView {
  view.contentDOM.setAttribute("aria-label", label);
  view.contentDOM.tabIndex = 0;
  return view;
}

/** Editable GLSL editor. `onChange` fires with the full document text on every edit. */
export function createSourceEditor(
  parent: HTMLElement,
  initialDoc: string,
  onChange: (doc: string) => void,
  ariaLabel: string,
): EditorView {
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      ...baseExtensions(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString());
      }),
    ],
  });
  return labelForA11y(new EditorView({ state, parent }), ariaLabel);
}

/** Read-only GLSL viewer, for the golfed-output panel. */
export function createReadOnlyEditor(parent: HTMLElement, initialDoc: string, ariaLabel: string): EditorView {
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [...baseExtensions(), EditorState.readOnly.of(true), EditorView.editable.of(false)],
  });
  return labelForA11y(new EditorView({ state, parent }), ariaLabel);
}

/** Replaces the full document content, e.g. when switching buffer tabs or re-running the golfer. */
export function setEditorContent(view: EditorView, text: string): void {
  if (view.state.doc.toString() === text) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
