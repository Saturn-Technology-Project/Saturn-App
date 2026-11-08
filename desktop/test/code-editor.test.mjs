// Editing behavior shared by source files and notebook cells, without a browser or model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CompletionContext, hasNextSnippetField, nextSnippetField, prevSnippetField } from "@codemirror/autocomplete";
import { insertNewlineAndIndent, toggleComment, undo } from "@codemirror/commands";
import { indentUnit, syntaxTree } from "@codemirror/language";
import { EditorSelection, StateField } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { createSourceState, EditorDocuments, indentationOf, indentCode, sourceActionKeys, sourceCompletions } from "../src/domain/code-editor.ts";

/** A command target that records real CodeMirror transactions without creating a view. */
function editor(content, language = "python", extensions = []) {
  let state = createSourceState(content, language, extensions);
  return { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
}

/** Move the main cursor, or select a span, as a person would before a command. */
function select(target, from, to = from) {
  target.dispatch(target.state.update({ selection: EditorSelection.single(from, to) }));
}

test("indentation follows existing spaces or tabs, with sensible language defaults", () => {
  assert.equal(indentationOf("", "python"), "    ");
  assert.equal(indentationOf("", "typescript"), "  ");
  assert.equal(indentationOf("def train():\n  if True:\n    pass\n", "python"), "  ");
  assert.equal(indentationOf("fn main() {\n\tprintln!();\n}\n", "rust"), "\t");
  assert.equal(indentationOf("x = (\n                 1,\n)\n", "python"), "    ", "alignment is not an indentation unit");
});

test("Tab inserts to the next indentation stop at each cursor; selections indent whole lines", () => {
  const target = editor("x =");
  select(target, 3);
  assert.equal(indentCode(target), true);
  assert.equal(target.state.sliceDoc(), "x = ");
  assert.equal(target.state.selection.main.head, 4);
  select(target, 0, 4);
  indentCode(target);
  assert.equal(target.state.sliceDoc(), "    x = ");
  const tabs = editor("\tfirst\n\tsecond");
  tabs.dispatch(tabs.state.update({ selection: EditorSelection.create([EditorSelection.cursor(6), EditorSelection.cursor(14)]) }));
  indentCode(tabs);
  assert.equal(tabs.state.sliceDoc(), "\tfirst\t\n\tsecond\t");
});

test("the editor binds Tab and Shift+Tab, and Escape permits leaving with Tab", () => {
  const target = editor("");
  const keys = target.state.facet(keymap).flat();
  const tab = keys.find(binding => binding.key === "Tab");
  assert.ok(tab.run(target));
  assert.equal(target.state.sliceDoc(), "    ");
  assert.ok(tab.shift(target));
  assert.equal(target.state.sliceDoc(), "");
  let focusMode = 0;
  assert.ok(keys.find(binding => binding.key === "Escape").run({ get state() { return target.state; }, dispatch: target.dispatch, setTabFocusMode(duration) { focusMode = duration; } }));
  assert.ok(focusMode > 0, "Escape must reach the tab-focus binding before the default selection binding");
});

test("Python Enter indents a block and Mod-/ comments follow the language", () => {
  const target = editor("def train():");
  select(target, target.state.doc.length);
  insertNewlineAndIndent(target);
  assert.equal(target.state.sliceDoc(), "def train():\n    ");
  const rust = editor("let step = 1;", "rust");
  toggleComment(rust);
  assert.equal(rust.state.sliceDoc(), "// let step = 1;");
});

test("local word completions wait for two letters and stay out of comments and strings", async () => {
  for (const [text, expected] of [["batch_size = 32\nba", true], ["batch_size = 32\nb", false], ["# batch_size ba", false], ['name = "batch_size ba"', false]]) {
    const target = editor(text);
    const pos = text.endsWith('"') ? text.length - 1 : text.length;
    const result = await sourceCompletions("python")(new CompletionContext(target.state, pos, false));
    assert.equal(Boolean(result?.options.some(option => option.label === "batch_size")), expected, text);
  }
});

test("completion sources keep their identity across queries and typing", () => {
  const target = editor("ma");
  const before = target.state.languageDataAt("autocomplete", 2);
  assert.deepEqual(target.state.languageDataAt("autocomplete", 2), before);
  target.dispatch(target.state.update({ changes: { from: 2, insert: "i" } }));
  assert.deepEqual(target.state.languageDataAt("autocomplete", 3), before, "pending completion results must still belong to the active source");
});

test("Python snippets use the file's indentation and Tab fields move both ways", async () => {
  const target = editor("ma");
  const result = await sourceCompletions("python")(new CompletionContext(target.state, 2, true));
  const completion = result.options.find(option => option.label === "main");
  assert.ok(completion);
  completion.apply(target, completion, result.from, 2);
  assert.equal(target.state.sliceDoc(), 'if __name__ == "__main__":\n    main()\n');
  assert.equal(target.state.sliceDoc(target.state.selection.main.from, target.state.selection.main.to), "main()");
  assert.ok(hasNextSnippetField(target.state));
  assert.ok(nextSnippetField(target));
  const withBlock = editor("wi");
  const withResult = await sourceCompletions("python")(new CompletionContext(withBlock.state, 2, true));
  const withCompletion = withResult.options.find(option => option.label === "with");
  withCompletion.apply(withBlock, withCompletion, withResult.from, 2);
  assert.ok(nextSnippetField(withBlock));
  assert.equal(withBlock.state.sliceDoc(withBlock.state.selection.main.from, withBlock.state.selection.main.to), "value");
  assert.ok(prevSnippetField(withBlock));
  assert.equal(withBlock.state.sliceDoc(withBlock.state.selection.main.from, withBlock.state.selection.main.to), "context");
});

test("official language parsers and language completion sources are available", () => {
  for (const [language, source] of [["python", "def train():\n    pass"], ["typescript", "const step: number = 1"], ["tsx", "const view = <div />"], ["rust", "fn main() {}"], ["json", '{"seed": 1}'], ["markdown", "# Research"], ["yaml", "seed: 1"], ["toml", "seed = 1"], ["shell", "echo hello"]]) {
    const target = editor(source, language);
    assert.ok(syntaxTree(target.state).length > 0, language);
  }
  assert.ok(editor("batch = 1").state.languageDataAt("autocomplete", 0).length >= 2, "Python's own bindings and builtins remain available");
});

test("editing and cached states preserve CRLF line endings", () => {
  const target = editor("if True:\r\n    pass\r\n");
  assert.equal(target.state.doc.lines, 3);
  select(target, target.state.doc.length);
  insertNewlineAndIndent(target);
  assert.equal(target.state.sliceDoc(), "if True:\r\n    pass\r\n\r\n");
});

test("save and notebook Shift-Enter run before the standard bindings", () => {
  let saved = 0, ran = 0;
  const target = editor("print(1)", "python", [sourceActionKeys(() => saved++, () => { ran++; return true; })]);
  const keys = target.state.facet(keymap).flat();
  assert.equal(keys.find(binding => binding.key === "Shift-Enter").run(target), true);
  assert.equal(ran, 1);
  assert.equal(target.state.sliceDoc(), "print(1)");
  assert.equal(keys.find(binding => binding.key === "Mod-s").run(target), true);
  assert.equal(saved, 1);
});

test("switching tabs preserves undo and selection while replacing old callbacks", () => {
  const oldField = StateField.define({ create: () => "old callback", update: value => value });
  const newField = StateField.define({ create: () => "new callback", update: value => value });
  const target = editor("seed = 1", "python", [oldField]);
  target.dispatch(target.state.update({ changes: { from: 7, to: 8, insert: "2" }, selection: { anchor: 8 } }));
  const documents = new EditorDocuments();
  const scroll = EditorView.scrollIntoView(8, { y: "start" });
  documents.remember("train.py", { state: target.state, language: "python", scroll });
  const restored = documents.open("train.py", "seed = 2", "python", [newField]);
  assert.equal(restored.state.selection.main.head, 8);
  assert.equal(restored.scroll, scroll);
  assert.equal(restored.state.field(oldField, false), undefined);
  assert.equal(restored.state.field(newField), "new callback");
  let state = restored.state;
  assert.ok(undo({ get state() { return state; }, dispatch(transaction) { state = transaction.state; } }));
  assert.equal(state.sliceDoc(), "seed = 1");
  assert.equal(state.facet(indentUnit), "    ");
});

test("external changes and a renamed language invalidate a cached history; the cache is bounded", () => {
  const documents = new EditorDocuments(2);
  const original = { state: createSourceState("seed = 1", "python"), language: "python", scroll: EditorView.scrollIntoView(5) };
  documents.remember("one.py", original);
  assert.equal(documents.open("one.py", "seed = 2", "python").scroll, undefined);
  documents.remember("one.py", original);
  assert.equal(documents.open("one.py", "seed = 1", "plain").scroll, undefined);
  for (const key of ["one.py", "two.py", "three.py"]) documents.remember(key, original);
  assert.equal(documents.open("one.py", "seed = 1", "python").scroll, undefined);
});
