// A Jupyter notebook as the Workspace edits it. Saving keeps what is not understood and, for what did not change, the
// very bytes it was read as: each cell remembers its text in the file, so a number written `1.0` or an unusual layout
// survives an edit somewhere else. nbformat 4 is what is read and written.
import { t } from "./i18n.ts";

/** What a cell holds, as far as Saturn understands it. A kind it does not know is kept and not edited. */
export type CellKind = "code" | "markdown" | "raw" | "other";

/** One cell. `raw` is what the file holds for it, with everything Saturn does not understand; `text` its exact text in the file until it changes. */
export interface NotebookCell {
  /** Names the cell while it is open: its id when it has a good one. Not written to the file by itself. */
  key: string;
  kind: CellKind;
  source: string;
  outputs: unknown[];
  executionCount: number | null;
  raw: unknown;
  text: string | null;
}

/** A notebook read from its file. */
export interface Notebook {
  /** The file's text as read, which a notebook with nothing changed saves as. */
  original: string;
  /** The file's text before the first cell's place, and after the last cell's. */
  head: string;
  tail: string;
  /** What stands between cells, before the first, and after the last. */
  separator: string;
  leading: string;
  closing: string;
  /** One level of the file's indentation. */
  indent: string;
  /** The cells' texts as read, to tell whether anything changed. */
  originalCells: string[];
  nbformat: number;
  nbformatMinor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
  /** The next number for a cell's key. */
  nextKey: number;
}

/** What reading a file came to: a notebook, or why it is not one. */
export type NotebookReading = { notebook: Notebook } | { problem: string };

/** The largest notebook that can be saved and opened again, as the runtime's limit on opening one. */
export const NOTEBOOK_SIZE_LIMIT = 8 * 1024 * 1024;

/** The filename of a notebook. */
export function isNotebookPath(path: string): boolean {
  return /\.ipynb$/i.test(path);
}

/** A plain object, as a JSON object reads. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text stored either way a notebook may: one string, or a list of lines. */
function joined(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value.join("");
  return null;
}

/** Text as a list of lines, each keeping its end, as nbformat writes it. */
function asLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Where the character after a JSON string starts. `start` is its opening quote. */
function afterString(text: string, start: number): number {
  let at = start + 1;
  while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
  return at + 1;
}

/** Where the character after a JSON value starts. The text has already parsed, so this only needs to find its end. */
function afterValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"') return afterString(text, start);
  if (first === "{" || first === "[") {
    let depth = 0;
    let at = start;
    for (;;) {
      const character = text[at];
      if (character === '"') {
        at = afterString(text, at);
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      if (character === "}" || character === "]") depth -= 1;
      at += 1;
      if (depth === 0) return at;
    }
  }
  let at = start;
  while (at < text.length && !/[,\]}\s]/.test(text[at] as string)) at += 1;
  return at;
}

/** Where the next character that is not white space is. */
function afterSpace(text: string, start: number): number {
  let at = start;
  while (at < text.length && /\s/.test(text[at] as string)) at += 1;
  return at;
}

/** Where a parsed file's top-level "cells" array and its items are. When a key repeats, JSON means the last one. */
function findCells(text: string): { open: number; close: number; items: [number, number][] } | null {
  let found: { open: number; close: number; items: [number, number][] } | null = null;
  let at = afterSpace(text, 0) + 1;
  for (;;) {
    at = afterSpace(text, at);
    if (text[at] === "}" || at >= text.length) return found;
    if (text[at] === ",") {
      at = afterSpace(text, at + 1);
    }
    const keyEnd = afterString(text, at);
    const key = JSON.parse(text.slice(at, keyEnd)) as string;
    const value = afterSpace(text, afterSpace(text, keyEnd) + 1);
    const end = afterValue(text, value);
    if (key === "cells") {
      const items: [number, number][] = [];
      let item = afterSpace(text, value + 1);
      while (text[item] !== "]") {
        const itemEnd = afterValue(text, item);
        items.push([item, itemEnd]);
        item = afterSpace(text, itemEnd);
        if (text[item] === ",") item = afterSpace(text, item + 1);
      }
      found = { open: value + 1, close: item, items };
    }
    at = end;
  }
}

/** A cell as Saturn sees it, with the key it goes by. */
function readCell(raw: unknown, text: string | null, key: string): NotebookCell {
  const fields = isObject(raw) ? raw : {};
  const known = fields.cell_type === "code" || fields.cell_type === "markdown" || fields.cell_type === "raw";
  const source = joined(fields.source);
  const usable = known && source !== null;
  return {
    key,
    kind: usable ? (fields.cell_type as CellKind) : "other",
    source: source ?? "",
    outputs: Array.isArray(fields.outputs) ? fields.outputs : [],
    executionCount: typeof fields.execution_count === "number" ? fields.execution_count : null,
    raw,
    text,
  };
}

/** Reads a notebook's file. What is not nbformat 4 says why, and is opened as text instead. */
export function parseNotebook(text: string): NotebookReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problem: t("It is not JSON: {reason}.", { reason: error instanceof Error ? error.message : String(error) }) };
  }
  if (!isObject(parsed)) return { problem: t("It is not a JSON object.") };
  if (parsed.nbformat !== 4) return { problem: t("It is nbformat {version}, and Saturn opens nbformat 4.", { version: String(parsed.nbformat) }) };
  if (!Array.isArray(parsed.cells)) return { problem: t("It has no list of cells.") };
  const place = findCells(text);
  if (!place || place.items.length !== parsed.cells.length) return { problem: t("Its list of cells could not be found.") };

  const seen = new Set<string>();
  let nextKey = 0;
  const originalCells: string[] = [];
  const cells = (parsed.cells as unknown[]).map((raw, index) => {
    const [from, to] = place.items[index] as [number, number];
    const cellText = text.slice(from, to);
    originalCells.push(cellText);
    const id = isObject(raw) && typeof raw.id === "string" ? raw.id : "";
    const key = id && !seen.has(id) ? id : `cell-${(nextKey += 1)}`;
    seen.add(key);
    return readCell(raw, cellText, key);
  });

  const first = place.items[0];
  const last = place.items.at(-1);
  const second = place.items[1];
  const indent = /^\s*\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? (/^\s*\{\s*"/.test(text) && !text.includes("\n") ? "" : " ");
  const lineEnd = indent ? "\n" : "";
  return {
    notebook: {
      original: text,
      head: text.slice(0, place.open),
      tail: text.slice(place.close),
      leading: first ? text.slice(place.open, first[0]) : `${lineEnd}${indent}${indent}`,
      closing: last ? text.slice(last[1], place.close) : `${lineEnd}${indent}`,
      separator: first && second ? text.slice(first[1], second[0]) : `,${lineEnd}${indent}${indent}`,
      indent,
      originalCells,
      nbformat: 4,
      nbformatMinor: typeof parsed.nbformat_minor === "number" ? parsed.nbformat_minor : 0,
      metadata: isObject(parsed.metadata) ? parsed.metadata : {},
      cells,
      nextKey,
    },
  };
}

/** A cell's text for the file, at the depth cells sit in it. */
function cellText(notebook: Notebook, cell: NotebookCell): string {
  if (cell.text !== null) return cell.text;
  const depth = notebook.leading.split("\n").at(-1) ?? "";
  return JSON.stringify(cell.raw, null, notebook.indent).replaceAll("\n", `\n${depth}`);
}

/** The notebook's file. With nothing changed, exactly what was read. */
export function serializeNotebook(notebook: Notebook): string {
  const { cells, originalCells } = notebook;
  if (cells.length === originalCells.length && cells.every((cell, index) => cell.text === originalCells[index])) return notebook.original;
  if (cells.length === 0) return `${notebook.head}${notebook.tail}`;
  return `${notebook.head}${notebook.leading}${cells.map((cell) => cellText(notebook, cell)).join(notebook.separator)}${notebook.closing}${notebook.tail}`;
}

/** The notebook with one cell changed. A cell it does not have, which a late event may name, changes nothing. */
function changeCell(notebook: Notebook, key: string, change: (cell: NotebookCell) => NotebookCell): Notebook {
  const index = notebook.cells.findIndex((cell) => cell.key === key);
  if (index < 0) return notebook;
  const cells = [...notebook.cells];
  cells[index] = change(cells[index] as NotebookCell);
  return { ...notebook, cells };
}

/** The cell with new stored fields, keeping the rest and where they stand. */
function withFields(cell: NotebookCell, fields: Record<string, unknown>): NotebookCell {
  return { ...cell, raw: { ...(isObject(cell.raw) ? cell.raw : {}), ...fields }, text: null };
}

/** The cell's source as the file stored it: a string stays a string, and a list stays a list. */
export function editCell(notebook: Notebook, key: string, source: string): Notebook {
  return changeCell(notebook, key, (cell) => {
    if (cell.source === source) return cell;
    const stored = isObject(cell.raw) && typeof cell.raw.source === "string" ? source : asLines(source);
    return { ...withFields(cell, { source: stored }), source };
  });
}

/** A new empty cell after `after`, or first without one. A notebook whose format has cell ids gives it one. */
export function addCell(notebook: Notebook, kind: "code" | "markdown", after: string | null, makeId: () => string = () => globalThis.crypto.randomUUID()): { notebook: Notebook; key: string } {
  const number = notebook.nextKey + 1;
  const hasIds = notebook.nbformatMinor >= 5;
  const id = hasIds ? makeId() : null;
  const key = id ?? `cell-${number}`;
  const raw = kind === "code"
    ? { cell_type: "code", execution_count: null, ...(id ? { id } : {}), metadata: {}, outputs: [], source: [] }
    : { cell_type: "markdown", ...(id ? { id } : {}), metadata: {}, source: [] };
  const cell: NotebookCell = { key, kind, source: "", outputs: [], executionCount: null, raw, text: null };
  const at = after === null ? 0 : notebook.cells.findIndex((item) => item.key === after) + 1;
  const cells = [...notebook.cells];
  cells.splice(at, 0, cell);
  return { notebook: { ...notebook, cells, nextKey: number }, key };
}

/** The notebook without a cell. */
export function deleteCell(notebook: Notebook, key: string): Notebook {
  return { ...notebook, cells: notebook.cells.filter((cell) => cell.key !== key) };
}

/** The cell moved by `by` places, as far as there are places. */
export function moveCell(notebook: Notebook, key: string, by: number): Notebook {
  const from = notebook.cells.findIndex((cell) => cell.key === key);
  const to = Math.min(Math.max(from + by, 0), notebook.cells.length - 1);
  if (from < 0 || from === to) return notebook;
  const cells = [...notebook.cells];
  const [moving] = cells.splice(from, 1);
  cells.splice(to, 0, moving as NotebookCell);
  return { ...notebook, cells };
}

/** The cell with these outputs and this execution count. */
function setOutputs(cell: NotebookCell, outputs: unknown[], executionCount: number | null): NotebookCell {
  return { ...withFields(cell, { outputs, execution_count: executionCount }), outputs, executionCount };
}

/** Every code cell without outputs. A cell that has none already stays as it was read. */
export function clearAllOutputs(notebook: Notebook): Notebook {
  return {
    ...notebook,
    cells: notebook.cells.map((cell) => (cell.kind === "code" && (cell.outputs.length > 0 || cell.executionCount !== null) ? setOutputs(cell, [], null) : cell)),
  };
}

/** A later stream's text added to the stream before it, as a notebook stores them; other outputs stand alone. */
function withOutput(outputs: unknown[], output: unknown): unknown[] {
  const last = outputs.at(-1);
  if (isObject(last) && isObject(output) && last.output_type === "stream" && output.output_type === "stream" && last.name === output.name) {
    const before = joined(last.text) ?? "";
    const added = joined(output.text) ?? "";
    return [...outputs.slice(0, -1), { ...last, text: before + added }];
  }
  return [...outputs, output];
}

/** How a run of a cell ended. */
export type CellRunStatus = "ok" | "error" | "aborted" | "skipped" | "dead";

/** What the runtime says about a notebook's kernel. `docs/research-contract.md` has the same list. */
export type KernelEvent =
  | ({ type: "state"; seq: number } & KernelStatus)
  | { type: "started"; seq: number; cell: string }
  | { type: "output"; seq: number; cell: string; output: unknown }
  | { type: "clear"; seq: number; cell: string; wait: boolean }
  | { type: "finished"; seq: number; cell: string; status: CellRunStatus; count: number | null }
  | { type: "ended"; seq: number }
  | { type: "gap" };

/** A notebook's kernel as far as the runtime has said. */
export interface KernelStatus {
  kernel: string | null;
  state: "none" | "starting" | "idle" | "busy" | "restarting" | "stopping" | "stopped" | "dead" | "missing" | "failed";
  python?: string;
  message?: string | null;
  missing: string[];
  running?: string | null;
  queued: string[];
  seq: number;
}

/** What is not kept in the file about a run in progress: cells whose outputs go when their next output comes. */
export type PendingClears = ReadonlySet<string>;

/** A kernel's event applied to the notebook and to the cells waiting for a clear. Other events change neither. */
export function applyKernelEvent(notebook: Notebook, clears: PendingClears, event: KernelEvent): { notebook: Notebook; clears: PendingClears } {
  const without = (cell: string) => {
    const next = new Set(clears);
    next.delete(cell);
    return next;
  };
  switch (event.type) {
    case "started":
      return { notebook: changeCell(notebook, event.cell, (cell) => setOutputs(cell, [], null)), clears: without(event.cell) };
    case "output":
      return {
        notebook: changeCell(notebook, event.cell, (cell) => setOutputs(cell, withOutput(clears.has(event.cell) ? [] : cell.outputs, event.output), cell.executionCount)),
        clears: without(event.cell),
      };
    case "clear":
      if (event.wait) return { notebook, clears: new Set(clears).add(event.cell) };
      return { notebook: changeCell(notebook, event.cell, (cell) => setOutputs(cell, [], cell.executionCount)), clears: without(event.cell) };
    case "finished":
      if (event.count === null) return { notebook, clears: without(event.cell) };
      return { notebook: changeCell(notebook, event.cell, (cell) => setOutputs(cell, cell.outputs, event.count)), clears: without(event.cell) };
    default:
      return { notebook, clears };
  }
}

/** The status the runtime's newest word gives, or what was known. */
export function nextKernelStatus(status: KernelStatus, event: KernelEvent): KernelStatus {
  return event.type === "state" ? event : status;
}

/** What the kernel's state means, in a word or two. */
export function kernelStateLabel(state: KernelStatus["state"]): string {
  const labels: Record<KernelStatus["state"], string> = {
    none: t("No kernel"),
    starting: t("Starting"),
    idle: t("Idle"),
    busy: t("Running"),
    restarting: t("Restarting"),
    stopping: t("Stopping"),
    stopped: t("Stopped"),
    dead: t("Stopped by itself"),
    missing: t("Cannot run"),
    failed: t("Could not start"),
  };
  return labels[state];
}

/** Why a run ended, when that is worth saying beside a cell. */
export function runStatusNote(status: CellRunStatus): string | null {
  const notes: Record<CellRunStatus, string | null> = {
    ok: null,
    error: null,
    aborted: t("Stopped before it finished."),
    skipped: t("Not run: an earlier cell did not finish."),
    dead: t("The kernel stopped while this ran."),
  };
  return notes[status];
}

/** The language a notebook says it is written in, or python when it does not say. */
export function notebookLanguage(notebook: Notebook): string {
  const spec = notebook.metadata.kernelspec;
  const info = notebook.metadata.language_info;
  const fromSpec = isObject(spec) && typeof spec.language === "string" ? spec.language : "";
  const fromInfo = isObject(info) && typeof info.name === "string" ? info.name : "";
  return (fromSpec || fromInfo || "python").toLowerCase();
}

/** The code cells that have something to run, in order, as the runtime takes them. */
export function runnableCells(notebook: Notebook): { cell: string; code: string }[] {
  return notebook.cells.filter((cell) => cell.kind === "code" && cell.source.trim()).map((cell) => ({ cell: cell.key, code: cell.source }));
}

/** A stored output as it is shown. Nothing here is ever rendered as anything but text or a PNG. */
export type OutputView =
  | { kind: "text"; text: string; failure: boolean }
  | { kind: "error"; title: string; traceback: string }
  | { kind: "image"; source: string; description: string }
  | { kind: "note"; text: string };

/** Text as a terminal would leave it: no color codes, and a line a carriage return overwrote keeps only its last write. */
export function plainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const noColor = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return noColor
    .split("\n")
    .map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      return trimmed.slice(trimmed.lastIndexOf("\r") + 1);
    })
    .join("\n");
}

/** A data bundle's best form to show: a PNG, then its plain text, then whatever other text it has, unrendered. */
function viewOfData(data: Record<string, unknown>): OutputView {
  const plain = joined(data["text/plain"]);
  const png = joined(data["image/png"]);
  if (png !== null && /^[A-Za-z0-9+/=\s]+$/.test(png)) {
    return { kind: "image", source: `data:image/png;base64,${png.replace(/\s/g, "")}`, description: plain ? plainText(plain) : t("An image from this cell") };
  }
  if (plain !== null) return { kind: "text", text: plainText(plain), failure: false };
  for (const [type, value] of Object.entries(data)) {
    const text = joined(value);
    if (text !== null && (!type.startsWith("image/") || type === "image/svg+xml")) return { kind: "text", text, failure: false };
    if (type.endsWith("json")) return { kind: "text", text: JSON.stringify(value, null, 2), failure: false };
  }
  const types = Object.keys(data).join(", ");
  return { kind: "note", text: types ? t("An output Saturn does not show: {types}.", { types }) : t("An output Saturn does not show: it is empty.") };
}

/** How one stored output is shown. */
export function outputView(output: unknown): OutputView {
  if (!isObject(output)) return { kind: "note", text: t("An output Saturn does not understand. It is kept in the file.") };
  switch (output.output_type) {
    case "stream":
      return { kind: "text", text: plainText(joined(output.text) ?? ""), failure: output.name === "stderr" };
    case "error":
      return {
        kind: "error",
        title: `${String(output.ename ?? "Error")}${output.evalue ? `: ${String(output.evalue)}` : ""}`,
        traceback: plainText(Array.isArray(output.traceback) ? output.traceback.map(String).join("\n") : ""),
      };
    case "display_data":
    case "execute_result": {
      const data = isObject(output.data) ? output.data : {};
      const metadata = isObject(output.metadata) ? output.metadata : {};
      if (isObject(metadata.saturn) && metadata.saturn.truncated === true) return { kind: "note", text: joined(data["text/plain"]) ?? t("Some of this cell's output was left out.") };
      return viewOfData(data);
    }
    default:
      return { kind: "note", text: t("An output Saturn does not understand ({type}). It is kept in the file.", { type: String(output.output_type) }) };
  }
}
