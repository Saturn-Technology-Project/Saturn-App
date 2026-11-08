// Which language a file in the Workspace is written in, and the token readers for the ones CodeMirror has no grammar
// for here: TeX and Lean 4. Each reader works on a stream of one line at a time, the shape CodeMirror's stream
// languages take, and names tokens by the highlighter's own names (`keyword`, `comment`, `string`, …), so the editor
// colors them with the same style as Python.

/** What the Workspace's editor highlights a file as. */
export type EditorLanguage = "python" | "javascript" | "jsx" | "typescript" | "tsx" | "json" | "rust" | "markdown" | "shell" | "yaml" | "toml" | "tex" | "lean" | "plain";

/** The language a file is in, by its name. */
export function languageOf(path: string): EditorLanguage {
  const lower = path.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
  if (lower.endsWith(".tex") || lower.endsWith(".sty") || lower.endsWith(".cls") || lower.endsWith(".bib")) return "tex";
  if (lower.endsWith(".lean")) return "lean";
  if (/\.(?:js|mjs|cjs)$/.test(lower)) return "javascript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (/\.(?:ts|mts|cts)$/.test(lower)) return "typescript";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".json") || lower.endsWith(".ipynb")) return "json";
  if (lower.endsWith(".rs")) return "rust";
  if (/\.(?:md|markdown)$/.test(lower)) return "markdown";
  if (/\.(?:sh|bash|zsh)$/.test(lower) || /(?:^|\/)\.(?:bashrc|zshrc|profile)$/.test(lower)) return "shell";
  if (/\.(?:yaml|yml)$/.test(lower)) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  return "plain";
}

/** The part of CodeMirror's string stream a token reader uses. */
export interface CharStream {
  sol(): boolean;
  eol(): boolean;
  peek(): string | void;
  next(): string | void;
  eat(match: string | RegExp | ((char: string) => boolean)): string | void;
  eatWhile(match: string | RegExp | ((char: string) => boolean)): boolean;
  match(pattern: string | RegExp, consume?: boolean): boolean | RegExpMatchArray | null;
  skipToEnd(): void;
  current(): string;
}

/** A token reader in the shape CodeMirror's `StreamLanguage.define` takes. */
export interface TokenReader<State> {
  startState(): State;
  token(stream: CharStream, state: State): string | null;
  languageData?: Record<string, unknown>;
}

/** Where a TeX reader is: in text, or inside a formula that `$`, `$$`, `\(` or `\[` opened. */
export interface TexState { math: "" | "$" | "$$" | "\\)" | "\\]" }

/**
 * TeX and LaTeX: commands are keywords, `\begin`/`\end` environments are type names, comments run to the end of the
 * line, braces and brackets are brackets, and a formula is colored as a string so it stands apart from the prose.
 */
export const tex: TokenReader<TexState> = {
  startState: () => ({ math: "" }),
  token(stream, state) {
    if (state.math) {
      if (stream.match(state.math)) {
        state.math = "";
        return "string";
      }
      if (stream.match("\\" + state.math.slice(-1))) return "string";
      if (stream.eat("\\")) {
        if (!stream.eatWhile(/[A-Za-z@]/)) stream.next();
        return "keyword";
      }
      // Everything else in a formula, up to the next command or closing mark, reads as the formula.
      while (!stream.eol()) {
        if (stream.peek() === "\\" || stream.match(state.math, false)) break;
        stream.next();
      }
      return "string";
    }
    if (stream.eat("%")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("$$") || stream.match("\\[")) {
      state.math = stream.current() === "$$" ? "$$" : "\\]";
      return "string";
    }
    if (stream.match("\\(")) {
      state.math = "\\)";
      return "string";
    }
    if (stream.eat("$")) {
      state.math = "$";
      return "string";
    }
    if (stream.eat("\\")) {
      if (stream.eatWhile(/[A-Za-z@]/)) {
        const command = stream.current();
        if ((command === "\\begin" || command === "\\end") && stream.match(/^\{[^}]*\}/)) return "typeName";
        return "keyword";
      }
      stream.next();
      return "keyword";
    }
    if (stream.eat(/[{}[\]]/)) return "bracket";
    if (stream.eat(/[&~^_]/)) return "operator";
    if (stream.eatWhile(/[^\\%${}[\]&~^_]/)) return null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "%" } },
};

/** The words Lean 4 reserves for declarations, structure and terms. */
const LEAN_KEYWORDS = new Set([
  "theorem", "lemma", "def", "abbrev", "example", "instance", "structure", "inductive", "class", "axiom", "opaque", "constant",
  "where", "extends", "deriving", "namespace", "section", "end", "open", "import", "export", "variable", "universe", "set_option",
  "attribute", "private", "protected", "noncomputable", "partial", "unsafe", "macro", "macro_rules", "syntax", "elab", "notation",
  "infix", "infixl", "infixr", "prefix", "postfix", "mutual", "termination_by", "decreasing_by",
  "fun", "λ", "let", "have", "show", "from", "by", "at", "with", "match", "if", "then", "else", "do", "return", "for", "in", "unless",
  "calc", "suffices", "obtain", "using", "this", "Type", "Prop", "Sort", "forall", "∀", "∃", "exists",
]);

/** The words a tactic proof begins its steps with. Read as keywords so a proof's shape shows. */
const LEAN_TACTICS = new Set([
  "intro", "intros", "rintro", "apply", "exact", "refine", "rw", "rwa", "simp", "simp_all", "simpa", "dsimp", "unfold", "cases",
  "rcases", "induction", "constructor", "use", "exists", "ext", "funext", "congr", "ring", "ring_nf", "linarith", "nlinarith",
  "omega", "norm_num", "field_simp", "positivity", "decide", "trivial", "rfl", "assumption", "contradiction", "exfalso", "left",
  "right", "split", "aesop", "tauto", "norm_cast", "push_cast", "specialize", "generalize", "subst", "symm", "trans", "calc",
  "change", "conv", "repeat", "first", "try", "all_goals", "any_goals", "case", "next", "show", "exact?", "apply?", "simp?",
]);

/** Where a Lean reader is: how deep inside `/- -/` comments, which nest, and whether a declaration's name is next. */
export interface LeanState { comment: number; naming: boolean }

/**
 * Lean 4: declarations and term keywords, tactics, `--` and nested `/- -/` comments, strings, numbers, `#` commands as
 * meta, the name a declaration gives as a definition, and `sorry` as invalid, since a proof with it proves nothing.
 */
export const lean: TokenReader<LeanState> = {
  startState: () => ({ comment: 0, naming: false }),
  token(stream, state) {
    if (state.comment) {
      while (!stream.eol()) {
        if (stream.match("/-")) {
          state.comment += 1;
        } else if (stream.match("-/")) {
          state.comment -= 1;
          if (state.comment === 0) return "comment";
        } else {
          stream.next();
        }
      }
      return "comment";
    }
    if (stream.match("--")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/-")) {
      state.comment = 1;
      return "comment";
    }
    if (stream.eat('"')) {
      let escaped = false;
      for (let char = stream.next(); typeof char === "string"; char = stream.next()) {
        if (char === '"' && !escaped) break;
        escaped = char === "\\" && !escaped;
      }
      return "string";
    }
    if (stream.match(/^#[A-Za-z_]+/)) return "meta";
    if (stream.match(/^0[xX][0-9a-fA-F]+/) || stream.match(/^\d+(\.\d+)?/)) return "number";
    if (stream.match(/^[A-Za-z_α-ωΑ-Ω][\w'!?.α-ωΑ-Ω₀-₉]*/)) {
      const word = stream.current();
      if (state.naming) {
        state.naming = false;
        return "def";
      }
      if (word === "sorry") return "invalid";
      if (word === "theorem" || word === "lemma" || word === "def" || word === "abbrev" || word === "structure" || word === "inductive" || word === "class" || word === "instance" || word === "axiom") {
        state.naming = true;
        return "keyword";
      }
      if (LEAN_KEYWORDS.has(word)) return "keyword";
      if (LEAN_TACTICS.has(word)) return "keyword";
      if (/^[A-Z]/.test(word)) return "typeName";
      return null;
    }
    if (stream.eat(/[()[\]{}⟨⟩]/)) return "bracket";
    if (stream.eat(/[:=→←↔∘∧∨¬≠≤≥∈∉⊆⊂∪∩×∑∏∫√∞+\-*/<>|^%!?@$&~,.;]/)) return "operator";
    if (stream.eatWhile(/[^\s]/)) return null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "--", block: { open: "/-", close: "-/" } } },
};
