import { useLayoutEffect, useRef, useState } from "react";
import { closeCompletion } from "@codemirror/autocomplete";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { gotoLine } from "@codemirror/search";
import { countColumn, type EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { EditorView } from "@codemirror/view";
import { createSourceState, sourceActionKeys, type EditorDocuments } from "../../domain/code-editor.js";
import type { EditorLanguage } from "../../domain/code-languages.js";
import { t } from "../../domain/i18n.js";
import { Button } from "../ui/base/Button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/base/Dialog.js";

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--stage)", color: "var(--fg)", fontSize: "13px" },
  ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)", caretColor: "var(--fg)" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--muted)", borderRight: "1px solid var(--line)" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-tooltip": { backgroundColor: "var(--elevated)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "6px", boxShadow: "0 6px 20px #0002" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "12px", maxHeight: "240px" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 8px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--focus)", color: "var(--fg)" },
  ".cm-completionDetail": { color: "var(--muted)", marginLeft: "12px" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "700" },
  ".cm-snippetField": { backgroundColor: "var(--focus)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)" },
  ".cm-panel input, .cm-panel button, .cm-textfield": { background: "var(--elevated)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "4px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--term-selection)" },
});

/** Code's colors, from the theme's own, so that they read in both light and dark. */
const codeColors = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--code-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)], color: "var(--code-function)" },
  { tag: [tags.className, tags.typeName, tags.namespace], color: "var(--code-type)" },
  { tag: [tags.meta, tags.bracket], color: "var(--code-type)" },
  { tag: tags.invalid, color: "var(--off)", textDecoration: "underline wavy" },
]);

/** A source file's language, shown without translating names of programming languages. */
const languageNames: Record<EditorLanguage, string> = { python: "Python", javascript: "JavaScript", jsx: "JavaScript JSX", typescript: "TypeScript", tsx: "TypeScript JSX", json: "JSON", rust: "Rust", markdown: "Markdown", shell: "Shell", yaml: "YAML", toml: "TOML", tex: "TeX", lean: "Lean", plain: "Text" };

/** Position and file conventions shown below a full editor, without announcing every keystroke. */
function positionOf(state: EditorState) {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  return { line: line.number, column: countColumn(line.text.slice(0, range.head - line.from), state.tabSize) + 1, selected: range.to - range.from, unit: state.facet(indentUnit), tabSize: state.tabSize, eol: state.lineBreak === "\r\n" ? "CRLF" : "LF" };
}

/** A source editor; an optional workspace cache preserves each tab's history, cursor and scroll position. */
export function SourceEditor(props: {
  documentKey: string;
  initialContent: string;
  language: EditorLanguage;
  documents?: EditorDocuments;
  cacheKey?: string;
  onChange: (content: string) => void;
  onSave: () => void;
  /** The selected text and the line it starts on, or nothing. */
  onSelection?: (selection: { text: string; line: number } | null) => void;
  /** Shift-Enter does this, where the code can be run from the editor. */
  onRun?: () => void;
  /** What assistive technology calls the editor. */
  label?: string;
  /** Grows with its text, for a notebook's cell, rather than filling its pane. */
  fit?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const [position, setPosition] = useState({ line: 1, column: 1, selected: 0, unit: "    ", tabSize: 4, eol: "LF" });
  const [help, setHelp] = useState(false);
  const handlers = useRef({ onChange: props.onChange, onSave: props.onSave, onSelection: props.onSelection, onRun: props.onRun });
  handlers.current = { onChange: props.onChange, onSave: props.onSave, onSelection: props.onSelection, onRun: props.onRun };

  useLayoutEffect(() => {
    if (!host.current) return undefined;
    const extensions = [
      sourceActionKeys(() => handlers.current.onSave(), () => {
        if (!handlers.current.onRun) return false;
        handlers.current.onRun();
        return true;
      }),
      editorTheme,
      syntaxHighlighting(codeColors),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) handlers.current.onChange(update.state.sliceDoc());
        if (!props.fit && (update.docChanged || update.selectionSet)) setPosition(positionOf(update.state));
        if (update.selectionSet) {
          const range = update.state.selection.main;
          handlers.current.onSelection?.(
            range.empty ? null : { text: update.state.sliceDoc(range.from, range.to), line: update.state.doc.lineAt(range.from).number },
          );
        }
      }),
      EditorView.contentAttributes.of({ "aria-label": props.label ?? t("Source file"), spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
    ];
    const cached = props.cacheKey ? props.documents?.open(props.cacheKey, props.initialContent, props.language, extensions) : undefined;
    const view = new EditorView({ state: cached?.state ?? createSourceState(props.initialContent, props.language, extensions), parent: host.current, scrollTo: cached?.scroll });
    editor.current = view;
    setPosition(positionOf(view.state));
    const range = view.state.selection.main;
    handlers.current.onSelection?.(range.empty ? null : { text: view.state.sliceDoc(range.from, range.to), line: view.state.doc.lineAt(range.from).number });
    return () => {
      closeCompletion(view);
      // Layout cleanup runs before React removes this pane; a detached editor has already lost its scroll position.
      if (props.cacheKey) props.documents?.remember(props.cacheKey, { state: view.state, language: props.language, scroll: view.scrollSnapshot() });
      editor.current = null;
      view.destroy();
    };
    // Only a new document replaces the editor: its content then lives in the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.documentKey, props.language, props.documents, props.cacheKey]);

  return <div className={props.fit ? "min-w-0 overflow-hidden rounded-sm border border-border [&_.cm-editor]:h-auto" : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}>
    <div ref={host} className={props.fit ? "min-w-0" : "min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full"} />
    {!props.fit ? <div className="flex h-6 flex-none items-center justify-end gap-3 overflow-hidden border-t border-border bg-panel px-2 font-mono text-[10px] whitespace-nowrap text-muted-foreground" aria-label={t("Editor status")}>
      <button type="button" className="cursor-pointer hover:text-foreground" title={t("Go to line (Ctrl+G)")} onClick={() => { if (editor.current) { editor.current.focus(); gotoLine(editor.current); } }}>{t("Ln {line}, Col {column}", { line: position.line, column: position.column })}</button>
      {position.selected ? <span>{t("{count} selected", { count: position.selected })}</span> : null}
      <span className="hidden sm:inline">{position.unit === "\t" ? t("Tabs: {count}", { count: position.tabSize }) : t("Spaces: {count}", { count: position.unit.length })}</span>
      <span className="hidden md:inline">UTF-8 · {position.eol}</span>
      <span>{languageNames[props.language]}</span>
      <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => setHelp(true)}>{t("Editor shortcuts")}</button>
    </div> : null}
    <Dialog open={help} onOpenChange={setHelp}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("Editor shortcuts")}</DialogTitle><DialogDescription>{t("Language and document completions run locally. Project-wide types and definitions need a language server.")}</DialogDescription></DialogHeader>
        <ul className="grid gap-3 text-xs text-muted-foreground">
          <li>{t("Tab: accept completion, next snippet field, or indent. Shift+Tab: previous field or outdent.")}</li>
          <li>{t("Ctrl+Space: suggestions. Enter: accept. Escape: dismiss, then Tab to leave the editor.")}</li>
          <li>{t("Ctrl/Cmd+S: save. Ctrl/Cmd+F: find and replace. Ctrl+G: go to line.")}</li>
          <li>{t("Ctrl/Cmd+/: comment. Ctrl/Cmd+D: select next match.")}</li>
          <li>{t("Alt+Up/Down: move line. Shift+Alt+Up/Down: duplicate line.")}</li>
        </ul>
        <DialogFooter><Button variant="outline" onClick={() => setHelp(false)}>{t("Close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
