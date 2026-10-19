/** Line diffs for reviewing agent edits: Myers' algorithm, printed as a unified diff. */

export type DiffResult = { diff: string; additions: number; deletions: number; binary: boolean };

type Op = { kind: " " | "-" | "+"; line: string };
type Row = { kind: " " | "-" | "+"; line: string; /** line has no trailing newline (end of file) */ bare: boolean };

/** Above this many changed lines on both sides together, the file is shown as replaced instead of diffed line by line. */
const MAX_LINES = 40_000;
/** Myers' edit distance cap; past it the trace would cost too much memory. */
const MAX_EDITS = 4_000;

export function isBinary(bytes: Buffer | null): boolean {
  return !!bytes && bytes.subarray(0, 8000).includes(0);
}

/** A unified diff from `before` to `after`; null means the file did not exist on that side. */
export function unifiedDiff(file: string, before: Buffer | null, after: Buffer | null, context = 3): DiffResult {
  if (isBinary(before) || isBinary(after)) {
    const same = !!before && !!after && before.equals(after);
    return { diff: same ? "" : `Binary file ${file} changed\n`, additions: 0, deletions: 0, binary: true };
  }
  // The last line of a file without a trailing newline differs from the same text with one, as in `diff -u`.
  const a = linesOf(before);
  const b = linesOf(after);
  const rows: (Row & { ai: number; bi: number })[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of diffLines(a, b)) {
    rows.push({ kind: op.kind, line: op.line.text, bare: op.line.bare, ai, bi });
    if (op.kind !== "+") ai += 1;
    if (op.kind !== "-") bi += 1;
  }
  const additions = rows.filter((row) => row.kind === "+").length;
  const deletions = rows.filter((row) => row.kind === "-").length;
  if (!additions && !deletions) return { diff: "", additions: 0, deletions: 0, binary: false };

  let diff = `--- ${before ? `a/${file}` : "/dev/null"}\n+++ ${after ? `b/${file}` : "/dev/null"}\n`;
  let index = 0;
  while (index < rows.length) {
    while (index < rows.length && rows[index].kind === " ") index += 1;
    if (index >= rows.length) break;
    const start = Math.max(0, index - context);
    let end = index;
    // Grow the hunk while the next change is within two context windows.
    for (;;) {
      while (end < rows.length && rows[end].kind !== " ") end += 1;
      let next = end;
      while (next < rows.length && rows[next].kind === " ") next += 1;
      if (next < rows.length && next - end <= context * 2) {
        end = next;
        continue;
      }
      end = Math.min(rows.length, end + context);
      break;
    }
    const slice = rows.slice(start, end);
    const oldCount = slice.filter((row) => row.kind !== "+").length;
    const newCount = slice.filter((row) => row.kind !== "-").length;
    diff += `@@ -${range(slice[0].ai, oldCount)} +${range(slice[0].bi, newCount)} @@\n`;
    for (const row of slice) {
      diff += `${row.kind}${row.line}\n`;
      if (row.bare) diff += "\\ No newline at end of file\n";
    }
    index = end;
  }
  return { diff, additions, deletions, binary: false };
}

/** Counts only, for summaries. */
export function diffStats(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const { additions, deletions } = unifiedDiff("", before, after, 0);
  return { additions, deletions };
}

function range(start: number, count: number): string {
  // Unified diffs number from 1; an empty side names the line before it.
  const first = count === 0 ? start : start + 1;
  return count === 1 ? `${first}` : `${first},${count}`;
}

type Line = { text: string; bare: boolean };

function linesOf(bytes: Buffer | null): Line[] {
  if (!bytes || !bytes.length) return [];
  const text = bytes.toString("utf8");
  const parts = text.split("\n");
  const newline = text.endsWith("\n");
  if (newline) parts.pop();
  return parts.map((part, index) => ({ text: part, bare: !newline && index === parts.length - 1 }));
}

type LineOp = { kind: Op["kind"]; line: Line };

const same = (x: Line, y: Line) => x.text === y.text && x.bare === y.bare;

/** The shortest edit script from a to b (Myers 1986), with a whole-file replace when that gets too costly. */
function diffLines(a: Line[], b: Line[]): LineOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && same(a[prefix], b[prefix])) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && same(a[a.length - 1 - suffix], b[b.length - 1 - suffix])) suffix += 1;
  const head = a.slice(0, prefix).map((line): LineOp => ({ kind: " ", line }));
  const tail = a.slice(a.length - suffix).map((line): LineOp => ({ kind: " ", line }));
  return [...head, ...myers(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)), ...tail];
}

function replaced(a: Line[], b: Line[]): LineOp[] {
  return [...a.map((line): LineOp => ({ kind: "-", line })), ...b.map((line): LineOp => ({ kind: "+", line }))];
}

function myers(a: Line[], b: Line[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (!n || !m || n + m > MAX_LINES) return replaced(a, b);
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  // trace[d] is v as it was before step d.
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && same(a[x], b[y])) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return replaced(a, b);

  const ops: LineOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const prev = trace[d];
    const k = x - y;
    let prevK: number;
    if (d === 0) prevK = 0;
    else prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : prev[offset + prevK];
    const prevY = prevX - prevK;
    // The snake: equal lines after the step's single edit.
    const startX = d === 0 ? 0 : prevK === k + 1 ? prevX : prevX + 1;
    const startY = startX - k;
    while (x > startX && y > startY) {
      ops.push({ kind: " ", line: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (prevK === k + 1) ops.push({ kind: "+", line: b[y - 1] });
      else ops.push({ kind: "-", line: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}
