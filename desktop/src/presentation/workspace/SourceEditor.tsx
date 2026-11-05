import { useEffect, useRef } from "react";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { keymap } from "@codemirror/view";

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--stage)", color: "var(--fg)", fontSize: "13px" },
  ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)", caretColor: "var(--fg)" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--muted)", borderRight: "1px solid var(--line)" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  ".cm-scroller": { overflow: "auto" },
});

/** Code's colors, from the theme's own, so that they read in both light and dark. */
const codeColors = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--code-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)], color: "var(--code-function)" },
  { tag: [tags.className, tags.typeName, tags.namespace], color: "var(--code-type)" },
  { tag: tags.invalid, color: "var(--off)" },
]);

/** A code editor. The undo history and selection live here; a new `documentKey` starts a new document. */
export function SourceEditor(props: {
  documentKey: string;
  initialContent: string;
  language: "python" | "plain";
  onChange: (content: string) => void;
  onSave: () => void;
  /** The selected text and the line it starts on, or nothing. */
  onSelection?: (selection: { text: string; line: number } | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onChange: props.onChange, onSave: props.onSave, onSelection: props.onSelection });
  handlers.current = { onChange: props.onChange, onSave: props.onSave, onSelection: props.onSelection };

  useEffect(() => {
    if (!host.current) return undefined;
    const view = new EditorView({
      doc: props.initialContent,
      parent: host.current,
      extensions: [
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              handlers.current.onSave();
              return true;
            },
          },
        ]),
        basicSetup,
        editorTheme,
        syntaxHighlighting(codeColors),
        ...(props.language === "python" ? [python()] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          if (update.selectionSet) {
            const range = update.state.selection.main;
            handlers.current.onSelection?.(
              range.empty ? null : { text: update.state.sliceDoc(range.from, range.to), line: update.state.doc.lineAt(range.from).number },
            );
          }
        }),
        EditorView.contentAttributes.of({ "aria-label": "Source file" }),
      ],
    });
    return () => view.destroy();
    // Only a new document replaces the editor: its content then lives in the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.documentKey]);

  return <div ref={host} className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full" />;
}
