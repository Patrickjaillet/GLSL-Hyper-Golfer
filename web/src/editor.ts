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
      color: "var(--paper)",
      backgroundColor: "var(--ink)",
      height: "100%",
      fontSize: "12px",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      caretColor: "var(--cyan)",
      padding: "10px 12px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--cyan)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(232,163,61,0.25)",
    },
    ".cm-gutters": {
      backgroundColor: "#0c0f0b",
      color: "#3a4a3a",
      border: "none",
      borderRight: "1px solid var(--ink-line)",
    },
    ".cm-activeLineGutter": { backgroundColor: "rgba(95,212,200,0.08)", color: "var(--paper-dim)" },
    ".cm-activeLine": { backgroundColor: "rgba(95,212,200,0.04)" },
    ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: "rgba(95,212,200,0.25)", outline: "none" },
    ".cm-tooltip": {
      backgroundColor: "var(--ink-raised)",
      border: "1px solid var(--ink-line)",
      color: "var(--paper)",
      fontFamily: "var(--font-mono)",
      fontSize: "11px",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "var(--cyan-dim)",
      color: "var(--ink)",
    },
    ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)" },
    "&.cm-editor.cm-focused": { outline: "none" },
    ".cm-error-line": { backgroundColor: "rgba(232, 97, 91, 0.18)" },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--amber)" },
  { tag: [t.typeName, t.atom, t.bool], color: "var(--cyan)" },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: "#9fd6ff" },
  { tag: t.variableName, color: "var(--paper)" },
  { tag: t.number, color: "#f0b357" },
  { tag: t.string, color: "#f0b357" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--paper-dim)", fontStyle: "italic" },
  { tag: t.operator, color: "var(--paper)" },
  { tag: [t.punctuation, t.bracket], color: "var(--paper-dim)" },
  { tag: t.meta, color: "var(--cyan-dim)" },
  { tag: t.definition(t.variableName), color: "var(--paper)", fontWeight: "600" },
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

/** Editable GLSL editor. `onChange` fires with the full document text on every edit. */
export function createSourceEditor(parent: HTMLElement, initialDoc: string, onChange: (doc: string) => void): EditorView {
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      ...baseExtensions(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString());
      }),
    ],
  });
  return new EditorView({ state, parent });
}

/** Read-only GLSL viewer, for the golfed-output panel. */
export function createReadOnlyEditor(parent: HTMLElement, initialDoc: string): EditorView {
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [...baseExtensions(), EditorState.readOnly.of(true), EditorView.editable.of(false)],
  });
  return new EditorView({ state, parent });
}

/** Replaces the full document content, e.g. when switching buffer tabs or re-running the golfer. */
export function setEditorContent(view: EditorView, text: string): void {
  if (view.state.doc.toString() === text) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
