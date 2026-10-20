/**
 * Splits a source file into chunks worth embedding: one per top-level declaration (function, class, method,
 * export…) where the language has recognizable ones, else fixed windows of lines. Chunks carry the lines they
 * cover, so a search hit can point at the file and line.
 */
export type Chunk = { start: number; end: number; text: string; name?: string };

/** Longest chunk; declarations past this are split into windows. */
const MAX_LINES = 120;
/** Fallback window and its overlap. */
const WINDOW = 60;
const OVERLAP = 10;
/** Files past this many lines are indexed by windows only (generated code, bundles). */
export const MAX_FILE_LINES = 20_000;

const DECLARATION: Record<string, RegExp> = {
  // A line that opens a top-level (or one-indented) definition.
  ts: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  js: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  py: /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/,
  go: /^(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  rs: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod|type|const|static)\s+([A-Za-z_]\w*)/,
  java: /^\s{0,4}(?:public|private|protected|static|final|abstract|synchronized|\s)*\s*(?:class|interface|enum|record|[\w<>[\],\s]+?)\s+([A-Za-z_]\w*)\s*(?:\(|\{|<)/,
  rb: /^\s*(?:def|class|module)\s+([A-Za-z_][\w.?!]*)/,
  php: /^\s*(?:abstract\s+|final\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:function|class|interface|trait)\s+([A-Za-z_]\w*)/,
  swift: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+|static\s+|final\s+)*(?:func|class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/,
  kt: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|data\s+|sealed\s+|abstract\s+|suspend\s+)*(?:fun|class|object|interface)\s+([A-Za-z_]\w*)/,
  cs: /^\s{0,4}(?:public|private|protected|internal|static|abstract|sealed|virtual|override|async|\s)*\s*(?:class|interface|struct|enum|record|[\w<>[\],\s]+?)\s+([A-Za-z_]\w*)\s*(?:\(|\{|<)/,
  c: /^(?:static\s+|inline\s+|extern\s+)*[\w*\s]+?\b([A-Za-z_]\w*)\s*\([^;]*$/,
};
const BY_EXTENSION: Record<string, keyof typeof DECLARATION> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts", js: "js", jsx: "js", mjs: "js", cjs: "js", py: "py", go: "go", rs: "rs",
  java: "java", rb: "rb", php: "php", swift: "swift", kt: "kt", kts: "kt", cs: "cs", c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", m: "c", mm: "c",
};

/** The language key for a file, or undefined for files that get window chunks only. */
export function languageOf(file: string): string | undefined {
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return BY_EXTENSION[extension];
}

export function chunkFile(file: string, content: string): Chunk[] {
  const lines = content.split("\n");
  if (lines.length > MAX_FILE_LINES) return [];
  const language = languageOf(file);
  const pattern = language ? DECLARATION[language] : undefined;
  if (!pattern) return windows(lines, 0, lines.length);

  // Declaration starts, then each chunk runs to the next start; a leading comment block stays with its declaration.
  const starts: { line: number; name: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index]!);
    if (match) starts.push({ line: index, name: match[1]! });
  }
  if (starts.length < 2) return windows(lines, 0, lines.length);
  const chunks: Chunk[] = [];
  const firstStart = commentAbove(lines, starts[0]!.line);
  if (firstStart > 0) chunks.push(...windows(lines, 0, firstStart));
  for (let index = 0; index < starts.length; index += 1) {
    const start = commentAbove(lines, starts[index]!.line);
    const next = index + 1 < starts.length ? commentAbove(lines, starts[index + 1]!.line) : lines.length;
    const end = Math.max(start + 1, next);
    if (end - start > MAX_LINES) chunks.push(...windows(lines, start, end, starts[index]!.name));
    else chunks.push({ start: start + 1, end, text: lines.slice(start, end).join("\n"), name: starts[index]!.name });
  }
  return chunks.filter((chunk) => chunk.text.trim());
}

/** Where the comment or decorators above a declaration begin, so they travel with it. */
function commentAbove(lines: string[], line: number): number {
  let start = line;
  while (start > 0 && /^\s*(\/\/|\/\*|\*|#|@|\/\*\*|"""|''')/.test(lines[start - 1]!) && lines[start - 1]!.trim()) start -= 1;
  return start;
}

function windows(lines: string[], from: number, to: number, name?: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = from; start < to; start += WINDOW - OVERLAP) {
    const end = Math.min(to, start + WINDOW);
    const text = lines.slice(start, end).join("\n");
    if (text.trim()) chunks.push({ start: start + 1, end, text, ...(name ? { name } : {}) });
    if (end >= to) break;
  }
  return chunks;
}
