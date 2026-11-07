// The Workspace's own token readers for TeX and Lean, run on CodeMirror's string stream, and which file is which.
import assert from "node:assert/strict";
import { test } from "node:test";
import { StringStream } from "@codemirror/language";
import { languageOf, lean, tex } from "../src/domain/code-languages.ts";

/** Every token of a text, line by line, as [text, token name]. */
function tokens(reader, text) {
  const state = reader.startState();
  const found = [];
  for (const line of text.split("\n")) {
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      const token = reader.token(stream, state);
      if (stream.current()) found.push([stream.current(), token]);
      stream.start = stream.pos;
    }
  }
  return found;
}

test("a file's language follows its name", () => {
  assert.equal(languageOf("train.py"), "python");
  assert.equal(languageOf("paper/main.tex"), "tex");
  assert.equal(languageOf("refs.bib"), "tex");
  assert.equal(languageOf("Proofs/Basic.lean"), "lean");
  assert.equal(languageOf("README.md"), "plain");
});

test("TeX: commands, environments, comments and formulas are told apart", () => {
  const found = tokens(tex, "\\begin{theorem} % a note\nLet $x^2 \\geq 0$ hold. \\emph{Always}.\n\\end{theorem}");
  assert.deepEqual(found.filter(([, token]) => token === "typeName").map(([text]) => text), ["\\begin{theorem}", "\\end{theorem}"]);
  assert.deepEqual(found.filter(([, token]) => token === "comment").map(([text]) => text), ["% a note"]);
  assert.ok(found.some(([text, token]) => text === "\\emph" && token === "keyword"));
  const formula = found.filter(([, token]) => token === "string").map(([text]) => text).join("");
  assert.equal(formula, "$x^2  0$", "the formula is a string apart from its commands");
  assert.ok(found.some(([text, token]) => text === "\\geq" && token === "keyword"));
});

test("TeX: a display formula may run over lines", () => {
  const found = tokens(tex, "\\[\na = b\n\\]\ntext");
  assert.ok(found.filter(([, token]) => token === "string").length >= 3);
  assert.deepEqual(found.at(-1), ["text", null]);
});

test("Lean: declarations name a definition, tactics are keywords, sorry is invalid, comments nest", () => {
  const found = tokens(lean, "/- outer /- inner -/ still -/ theorem add_zero' (n : Nat) : n + 0 = n := by\n  simp -- done\nexample : True := sorry\n#check add_zero'");
  assert.equal(found.filter(([, token]) => token === "comment").map(([text]) => text).join(""), "/- outer /- inner -/ still -/-- done");
  assert.ok(!found.some(([text, token]) => text === "still" && token !== "comment"), "a nested comment stays a comment to its outer close");
  assert.ok(found.some(([text, token]) => text === "theorem" && token === "keyword"));
  assert.ok(found.some(([text, token]) => text === "add_zero'" && token === "def"));
  assert.ok(found.some(([text, token]) => text === "Nat" && token === "typeName"));
  assert.ok(found.some(([text, token]) => text === "simp" && token === "keyword"));
  assert.ok(found.some(([text, token]) => text === "sorry" && token === "invalid"));
  assert.ok(found.some(([text, token]) => text === "#check" && token === "meta"));
  assert.ok(found.some(([text, token]) => text === "0" && token === "number"));
});
