// Source editing without model calls: language parsers, local completions, indentation and per-workspace histories.
import { acceptCompletion, autocompletion, clearSnippet, closeCompletion, completeAnyWord, nextSnippetField, prevSnippetField, snippetCompletion, snippetKeymap, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { indentLess, indentMore, simplifySelection, temporarilySetTabFocusMode } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { indentUnit, StreamLanguage, syntaxTree } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { linter } from "@codemirror/lint";
import { gotoLine } from "@codemirror/search";
import { countColumn, EditorSelection, EditorState, Prec, StateEffect, Text, type Extension, type StateCommand } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { lean, tex, type EditorLanguage } from "./code-languages.ts";

/** Short additions to the languages' own snippets; placeholders remain editable with Tab. */
const snippets: Partial<Record<EditorLanguage, Completion[]>> = {
  python: [
    snippetCompletion('if __name__ == "__main__":\n\t${main()}\n${}', { label: "main", detail: "entry point", type: "text" }),
    snippetCompletion("with ${context} as ${value}:\n\t${pass}", { label: "with", detail: "context manager", type: "text" }),
    snippetCompletion("def test_${name}():\n\tassert ${condition}\n${}", { label: "test", detail: "test function", type: "text" }),
  ],
  rust: [
    snippetCompletion("fn ${name}(${args}) {\n\t${}\n}", { label: "fn", detail: "function", type: "text" }),
    snippetCompletion("for ${item} in ${iter} {\n\t${}\n}", { label: "for", detail: "loop", type: "text" }),
    snippetCompletion("impl ${Type} {\n\t${}\n}", { label: "impl", detail: "implementation", type: "text" }),
  ],
};

/** Infer a repeated indentation step, ignoring long continuation alignments. */
export function indentationOf(content: string, language: EditorLanguage): string {
  const counts = new Map<number, number>();
  let tabs = 0, spaces = 0, previous = 0;
  for (const line of content.split(/\r\n|[\r\n]/).slice(0, 1000)) {
    if (!line.trim()) continue;
    const prefix = /^[\t ]*/.exec(line)![0];
    if (prefix.startsWith("\t")) { tabs++; continue; }
    if (prefix.length) spaces++;
    const step = prefix.length - previous;
    if (step >= 2 && step <= 8) counts.set(step, (counts.get(step) ?? 0) + 1);
    previous = prefix.length;
  }
  if (tabs > spaces) return "\t";
  const width = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  return " ".repeat(width ?? (["python", "rust"].includes(language) ? 4 : 2));
}

/** Official parsers supply syntax, language-aware indentation, folding, comments and their own completions. */
function grammar(language: EditorLanguage): Extension {
  switch (language) {
    case "python": return python();
    case "javascript": case "jsx": case "typescript": case "tsx":
      return javascript({ typescript: language === "typescript" || language === "tsx", jsx: language === "jsx" || language === "tsx" });
    case "json": return [json(), linter(jsonParseLinter())];
    case "rust": return rust();
    case "markdown": return markdown();
    case "shell": return StreamLanguage.define(shell);
    case "toml": return StreamLanguage.define(toml);
    case "yaml": return StreamLanguage.define(yaml);
    case "tex": return StreamLanguage.define(tex);
    case "lean": return StreamLanguage.define(lean);
    default: return [];
  }
}

/** Supplement language completions with document words, without interrupting prose in strings and comments. */
export function sourceCompletions(language: EditorLanguage): CompletionSource {
  return async (context) => {
    for (let node = syntaxTree(context.state).resolveInner(context.pos, -1); node; node = node.parent!) {
      if (/comment|string/i.test(node.name)) return null;
    }
    const word = context.matchBefore(/[\w$]+/);
    if (!context.explicit && (!word || word.text.length < 2)) return null;
    const words = await completeAnyWord(context);
    const options = [...(words?.options ?? []), ...(snippets[language] ?? [])];
    return options.length ? { from: word?.from ?? context.pos, options, validFor: /^[\w$]*$/ } : null;
  };
}

/** Tab inserts to the next stop at cursors; selected lines move together. */
export const indentCode: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.some(range => !range.empty)) return indentMore({ state, dispatch });
  const unit = state.facet(indentUnit);
  const changes = state.changeByRange(range => {
    const line = state.doc.lineAt(range.head);
    const column = countColumn(line.text.slice(0, range.head - line.from), state.tabSize);
    const insert = unit === "\t" ? "\t" : " ".repeat(unit.length - column % unit.length);
    return { changes: { from: range.head, insert }, range: EditorSelection.cursor(range.head + insert.length) };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** Shared bindings preserve notebook Shift-Enter and provide an Escape-then-Tab path out of the editor. */
const editingKeys = Prec.highest(keymap.of([
  { key: "Tab", run: view => acceptCompletion(view) || nextSnippetField(view) || indentCode(view), shift: view => prevSnippetField(view) || indentLess(view) },
  { key: "Ctrl-g", run: gotoLine },
  { key: "Escape", run: view => {
    closeCompletion(view);
    clearSnippet(view);
    simplifySelection(view);
    return temporarilySetTabFocusMode(view);
  } },
]));

/** Save and notebook execution take priority over the standard newline bindings. */
export function sourceActionKeys(save: () => void, run: () => boolean): Extension {
  return Prec.high(keymap.of([
    { key: "Mod-s", preventDefault: true, run: () => { save(); return true; } },
    { key: "Shift-Enter", run },
  ]));
}

/** Build a state with the file's indentation and line endings; UI-specific listeners are supplied by the view. */
export function createSourceState(content: string, language: EditorLanguage, extensions: Extension = []): EditorState {
  return EditorState.create({ doc: Text.of(content.split(/\r\n|[\r\n]/)), extensions: sourceExtensions(content, language, extensions) });
}

/** Reconfiguration uses the same history field while replacing listeners belonging to an old component. */
function sourceExtensions(content: string, language: EditorLanguage, extensions: Extension): Extension {
  const unit = indentationOf(content, language);
  const completions = sourceCompletions(language);
  return [
    editingKeys, basicSetup, snippetKeymap.of([]),
    indentUnit.of(unit), EditorState.tabSize.of(unit === "\t" ? 4 : unit.length),
    EditorState.lineSeparator.of(content.includes("\r\n") ? "\r\n" : "\n"),
    grammar(language),
    autocompletion({ activateOnTypingDelay: 100, interactionDelay: 0 }),
    EditorState.languageData.of(() => [{ autocomplete: completions }]),
    extensions,
  ];
}

/** An in-memory document, including its scroll position; never serialized into project records. */
export interface EditorDocument { state: EditorState; language: EditorLanguage; scroll?: ReturnType<EditorView["scrollSnapshot"]> }

/** A small per-workspace cache: tabs keep undo and selection, but changed files start fresh. */
export class EditorDocuments {
  private documents = new Map<string, EditorDocument>();
  private limit: number;

  /** Keep at most this many recently visited files. */
  constructor(limit = 12) { this.limit = Math.max(1, limit); }

  /** Restore a matching file and replace its UI listeners; external edits invalidate its old history. */
  open(key: string, content: string, language: EditorLanguage, extensions: Extension = []): EditorDocument {
    const found = this.documents.get(key);
    this.documents.delete(key);
    if (found?.language === language && found.state.sliceDoc() === content) {
      return { ...found, state: found.state.update({ effects: StateEffect.reconfigure.of(sourceExtensions(content, language, extensions)) }).state };
    }
    return { state: createSourceState(content, language, extensions), language };
  }

  /** Bound retained documents and avoid caching a very large file and all of its undo text. */
  remember(key: string, document: EditorDocument): void {
    this.documents.delete(key);
    if (document.state.doc.length > 4 * 1024 * 1024) return;
    this.documents.set(key, document);
    while (this.documents.size > this.limit) this.documents.delete(this.documents.keys().next().value!);
  }
}
