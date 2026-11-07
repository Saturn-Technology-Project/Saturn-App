// The Markdown an assistant's answer is read as: the common forms are drawn, and what is not understood stays as text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasMarkdown, inlineText, parseInline, parseMarkdown, plainText } from "../src/domain/markdown.ts";

test("headings, paragraphs, lists, quotes, rules and fenced code are told apart", () => {
  const blocks = parseMarkdown(["## Findings", "", "The loss **fell** by `0.3`.", "Second line of the same paragraph.", "", "- one", "- two", "  - nested", "", "1. first", "2. second", "", "> a quote", "> goes on", "", "---", "", "```python", "print(1)", "```"].join("\n"));
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "list", "list", "quote", "rule", "code"]);
  assert.equal(blocks[0].level, 2);
  assert.deepEqual(blocks[1].children.map((inline) => inline.kind), ["text", "strong", "text", "code", "text"]);
  assert.equal(inlineText(blocks[1].children), "The loss fell by 0.3.\nSecond line of the same paragraph.");
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[2].items[1].nested.kind, "list");
  assert.equal(inlineText(blocks[2].items[1].nested.items[0].children), "nested");
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[3].items.length, 2);
  assert.equal(plainText(blocks[4].blocks), "a quote\ngoes on");
  assert.deepEqual(blocks[6], { kind: "code", lang: "python", text: "print(1)" });
});

test("a table needs its rule line, and cells keep their inline marks and escaped bars", () => {
  const [table] = parseMarkdown("| Model | Score |\n|---|---:|\n| `a` | **0.9** |\n| b \\| c | 0.1 |");
  assert.equal(table.kind, "table");
  assert.deepEqual(table.header.map(inlineText), ["Model", "Score"]);
  assert.deepEqual(table.rows.map((row) => row.map(inlineText)), [["a", "0.9"], ["b | c", "0.1"]]);
  assert.equal(table.rows[0][1][0].kind, "strong");
  const [notTable] = parseMarkdown("| just | bars |");
  assert.equal(notTable.kind, "paragraph");
});

test("inline marks nest, code shields its contents, and links need a web address", () => {
  const inlines = parseInline("**bold with `code` in it** and *em* and ~~gone~~ and [a link](https://example.org/x) and https://example.org/y.");
  assert.deepEqual(inlines.map((inline) => inline.kind), ["strong", "text", "em", "text", "strike", "text", "link", "text", "link", "text"]);
  assert.deepEqual(inlines[0].children.map((inline) => inline.kind), ["text", "code", "text"]);
  assert.equal(inlines[6].href, "https://example.org/x");
  assert.equal(inlines[8].href, "https://example.org/y");
  assert.equal(inlineText(parseInline("`**not bold**`")), "**not bold**");
  assert.equal(parseInline("[x](javascript:alert(1))")[0].kind, "text");
  assert.equal(inlineText(parseInline("snake_case_name stays and 2*3*4 stays")), "snake_case_name stays and 2*3*4 stays");
  assert.equal(parseInline("a \\*literal\\* star")[0].text, "a *literal* star");
});

test("an unclosed fence runs to the end, and plain text is left alone", () => {
  const blocks = parseMarkdown("```\nopen\nstill code");
  assert.deepEqual(blocks, [{ kind: "code", lang: "", text: "open\nstill code" }]);
  assert.equal(hasMarkdown("Just a sentence.\n\nAnd another."), false);
  assert.equal(hasMarkdown("A **bold** word."), true);
  assert.equal(hasMarkdown("- a list"), true);
});

test("a list ends at a paragraph, and an item's continuation line stays with it", () => {
  const blocks = parseMarkdown("- first item\n  goes on\n- second\n\nAfter the list.");
  assert.deepEqual(blocks.map((block) => block.kind), ["list", "paragraph"]);
  assert.equal(inlineText(blocks[0].items[0].children), "first item\ngoes on");
  assert.equal(blocks[0].items.length, 2);
});
