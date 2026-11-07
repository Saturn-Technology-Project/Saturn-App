// The Markdown an assistant writes, read into blocks the interface can draw: headings, paragraphs, lists, quotes,
// fenced code, tables and rules, with bold, italic, code, links and strikethrough inside them. It reads the common
// forms only, never HTML, and what it does not understand stays as text, so nothing is lost.

/** A run of text inside a block. */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

/** One item of a list, with the list nested under it, if any. */
export interface ListItem { children: Inline[]; nested: Block | null }

/** A block of the document. */
export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

const FENCE = /^(\s{0,3})(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The blocks of a Markdown text. */
export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

/** Whether a text has any Markdown in it worth drawing, beyond paragraphs. */
export function hasMarkdown(text: string): boolean {
  return parseMarkdown(text).some((block) => block.kind !== "paragraph" || block.children.some((inline) => inline.kind !== "text"));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[2] ?? "```";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !closesFence(lines[index] ?? "", marker)) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", lang: fence[3] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, children: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? "")) {
        inner.push((lines[index] ?? "").match(QUOTE)?.[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(inner) });
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "")) {
      const header = cells(line);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? "")) {
        rows.push(cells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const item = listItem(line);
    if (item) {
      const [list, next] = parseList(lines, index, item.indent);
      blocks.push(list);
      index = next;
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !startsBlock(lines[index] ?? "", lines[index + 1] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.map((part) => part.trim()).join("\n")) });
  }
  return blocks;
}

/** Whether a line closes a fence opened with `marker`: the same character, at least as many. */
function closesFence(line: string, marker: string): boolean {
  const close = line.match(/^\s{0,3}(```+|~~~+)\s*$/);
  return !!close && (close[1] ?? "").startsWith(marker[0] ?? "`") && (close[1] ?? "").length >= marker.length;
}

/** Whether a line opens a block other than a paragraph, so a paragraph ends before it. */
function startsBlock(line: string, next: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || !!listItem(line) || (TABLE_ROW.test(line) && TABLE_RULE.test(next));
}

/** A line's list marker, if it is an item: its indent, whether it is numbered, its number and its text. */
function listItem(line: string): { indent: number; ordered: boolean; number: number; text: string } | null {
  const bullet = line.match(BULLET);
  if (bullet) return { indent: (bullet[1] ?? "").length, ordered: false, number: 1, text: bullet[3] ?? "" };
  const numbered = line.match(NUMBERED);
  if (numbered) return { indent: (numbered[1] ?? "").length, ordered: true, number: Number(numbered[2] ?? "1"), text: numbered[3] ?? "" };
  return null;
}

/** A list from `start`, whose items sit at `indent`; lines indented further belong to the item before them. */
function parseList(lines: string[], start: number, indent: number): [Block, number] {
  const first = listItem(lines[start] ?? "");
  const ordered = first?.ordered ?? false;
  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const item = listItem(line);
    if (!item || item.indent !== indent || item.ordered !== ordered) break;
    const text = [item.text];
    const nested: string[] = [];
    index += 1;
    while (index < lines.length) {
      const following = lines[index] ?? "";
      if (!following.trim()) {
        // A blank line ends the list unless an indented line follows it.
        const after = lines[index + 1] ?? "";
        if (after.trim() && leading(after) > indent) {
          nested.push("");
          index += 1;
          continue;
        }
        break;
      }
      const deeper = listItem(following);
      if (deeper && deeper.indent > indent) {
        nested.push(following);
        index += 1;
        continue;
      }
      if (deeper || leading(following) <= indent) break;
      // A continuation line of the item's own text.
      if (nested.length) nested.push(following);
      else text.push(following.trim());
      index += 1;
    }
    const inner = nested.some((part) => part.trim()) ? parseBlocks(nested.map((part) => part.slice(Math.min(leading(part), indent + 1)))) : [];
    items.push({ children: parseInline(text.join("\n")), nested: inner[0] ?? null });
  }
  return [{ kind: "list", ordered, start: first?.number ?? 1, items }, index];
}

function leading(line: string): number {
  return line.length - line.trimStart().length;
}

/** The cells of a table row, each read for its inline marks. A `\|` stays a bar inside a cell. */
function cells(line: string): Inline[][] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => parseInline(cell.replace(/\\\|/g, "|").trim()));
}

/** The inline marks of a text: code first, since nothing inside it counts, then links, bold, italic and strikethrough. */
export function parseInline(text: string): Inline[] {
  const result: Inline[] = [];
  let rest = text;
  let plain = "";
  const flush = () => {
    if (plain) result.push({ kind: "text", text: plain });
    plain = "";
  };
  while (rest) {
    const code = rest.match(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
    if (code) {
      flush();
      result.push({ kind: "code", text: (code[2] ?? "").trim() });
      rest = rest.slice(code[0].length);
      continue;
    }
    const link = rest.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/);
    if (link) {
      flush();
      result.push({ kind: "link", href: link[2] ?? "", children: parseInline(link[1] ?? "") });
      rest = rest.slice(link[0].length);
      continue;
    }
    const bare = rest.match(/^<?(https?:\/\/[^\s<>)]+)>?/);
    if (bare && (plain === "" || /\s$/.test(plain))) {
      flush();
      const href = (bare[1] ?? "").replace(/[.,;:!?]+$/, "");
      result.push({ kind: "link", href, children: [{ kind: "text", text: href }] });
      rest = rest.slice(bare[0].startsWith("<") ? bare[0].length : href.length);
      continue;
    }
    const strong = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/);
    if (strong) {
      flush();
      result.push({ kind: "strong", children: parseInline(strong[2] ?? "") });
      rest = rest.slice(strong[0].length);
      continue;
    }
    const strike = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/);
    if (strike) {
      flush();
      result.push({ kind: "strike", children: parseInline(strike[1] ?? "") });
      rest = rest.slice(strike[0].length);
      continue;
    }
    const em = rest.match(/^(\*|_)(?=\S)([^*_\n]*?\S)\1(?![\w*_])/);
    if (em && (em[1] === "*" || plain === "" || /[\s(]$/.test(plain))) {
      flush();
      result.push({ kind: "em", children: parseInline(em[2] ?? "") });
      rest = rest.slice(em[0].length);
      continue;
    }
    if (rest.startsWith("\\") && rest.length > 1 && /[\\`*_{}[\]()#+\-.!|~<>]/.test(rest[1] ?? "")) {
      plain += rest[1];
      rest = rest.slice(2);
      continue;
    }
    plain += rest[0];
    rest = rest.slice(1);
  }
  flush();
  return result;
}

/** A document's text with its marks taken out, for a place that shows one line. */
export function plainText(blocks: Block[]): string {
  return blocks.map(blockText).join("\n");
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return inlineText(block.children);
    case "list":
      return block.items.map((item) => inlineText(item.children) + (item.nested ? `\n${blockText(item.nested)}` : "")).join("\n");
    case "quote":
      return block.blocks.map(blockText).join("\n");
    case "code":
      return block.text;
    case "table": {
      const rows: Inline[][][] = [block.header, ...block.rows];
      return rows.map((row) => row.map(inlineText).join(" | ")).join("\n");
    }
    case "rule":
      return "";
  }
}

export function inlineText(inlines: Inline[]): string {
  return inlines.map((inline) => (inline.kind === "text" || inline.kind === "code" ? inline.text : inlineText(inline.children))).join("");
}
