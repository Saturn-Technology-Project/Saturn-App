// What the runtime says about a project's data files, and how the Data screen words it. A name is not proof, and an overlap
// finds exact duplicates only, so what is said here never claims more than that.

/** How a run reads against a file as test data: by its version's declared split, by the file's name, or the two at odds. */
export type TestRead = "declared" | "name" | "conflict";

/** A run that read a file. */
export interface DataRun {
  id: string;
  versionId: string;
  experimentId: string;
  status: string;
  at: string;
  split: string | null;
  testRead: TestRead | null;
}

/** A version that froze a file. */
export interface DataFrozen {
  versionId: string;
  number: number;
  experimentId: string;
  sha256: string;
  size: number;
  frozenAt: string;
}

/** A file named as a data input by an experiment or a version. */
export interface DataFile {
  path: string;
  kind: "file" | "dataset";
  format: string;
  exists: boolean;
  problem: string | null;
  size: number | null;
  modifiedAt: string | null;
  frozen: DataFrozen | null;
  frozenBy: DataFrozen[];
  changed: boolean | null;
  looksLikeTest: boolean;
  declaredSplits: string[];
  testReads: number;
  experiments: { id: string; title: string }[];
  runs: DataRun[];
}

/** Every data input of a project. */
export interface DataList {
  items: DataFile[];
  filesCapped: boolean;
  note: string;
}

/** One row of a page: the row, or why it cannot be read. */
export interface DataRowItem {
  offset: number;
  row?: unknown;
  problem?: string;
  raw?: string;
}

/** A page of a file's rows. */
export interface DataPage {
  path: string;
  format: string;
  size: number;
  columns: string[];
  split: string | null;
  splits: string[];
  items: DataRowItem[];
  next: number | null;
  maxRowBytes: number;
  note: string;
}

/** What one column holds. */
export interface DataColumn {
  name: string;
  kind: "number" | "text" | "other" | "mixed" | "empty";
  present: number;
  missing: number;
  numbers: number;
  texts: number;
  others: number;
  distinct: number;
  distinctCapped: boolean;
  common: { value: string; count: number }[];
  range: { min: number; max: number } | null;
  lengths: { min: number; max: number } | null;
}

/** What a file's columns hold. */
export interface DataProfile {
  path: string;
  format: string;
  size: number;
  rows: number;
  malformed: number;
  tooLong: number;
  columns: DataColumn[];
  columnsCapped: boolean;
  split: string | null;
  splits: string[];
  remembered: boolean;
  note: string;
}

/** One file's side of an overlap. */
export interface DataOverlapSide {
  path: string;
  split: string | null;
  rows: number;
  malformed: number;
  tooLong: number;
  withoutColumns: number;
  inBoth: number;
}

/** What two files share. */
export interface DataOverlap {
  left: DataOverlapSide;
  right: DataOverlapSide;
  sharedDistinct: number;
  comparedBy: "row" | "columns";
  columns: string[];
  capped: boolean;
  note: string;
}

/** Where a file stands, in a word, and what color that word is. Color marks only what needs looking at. */
export function dataFileState(file: DataFile): { label: string; tone: "neutral" | "wait" | "bad" } {
  if (file.problem) return { label: "Refused", tone: "bad" };
  if (!file.exists) return { label: "Missing", tone: "bad" };
  if (file.changed) return { label: "Changed since frozen", tone: "wait" };
  if (file.frozen) return { label: "As frozen", tone: "neutral" };
  return { label: "Not frozen", tone: "neutral" };
}

/** Whether a format is read by the helper in the project's Python, which needs `datasets`. */
export function usesHelper(format: string): boolean {
  return format === "parquet" || format === "arrow" || format === "dataset";
}

/** Whether a file can be asked about at all. */
export function isReadable(file: DataFile): boolean {
  return file.exists && !file.problem && file.format !== "other";
}

/** A count with its noun, and an s when it takes one. */
function counted(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/** What the list says about how a file was read as test data. */
export function testReadSummary(file: DataFile): string {
  if (file.testReads > 0) {
    const declared = file.runs.filter((run) => run.testRead === "declared").length;
    const reads = counted(file.testReads, "run");
    return declared === file.testReads ? `${reads}, declared test` : `${reads}, ${declared ? "partly by name" : "by name only"}`;
  }
  return file.looksLikeTest ? "Name looks like test, no runs" : "";
}

/** What one run says about a file being test data, plainly about how much that is worth. */
export function testReadText(run: DataRun): string {
  if (run.testRead === "declared") return `Its version declares the split "${run.split}".`;
  if (run.testRead === "conflict") return `Its version declares the split "${run.split}", but the file's name looks like a test split. One of them is wrong.`;
  if (run.testRead === "name") return "No split declared. The file's name looks like a test split, which is not proof.";
  return run.split ? `Its version declares the split "${run.split}".` : "No split declared, and the name does not look like a test split.";
}

/** The columns of a page: what the header names, then whatever else its rows have, in the order they come. */
export function rowColumns(page: Pick<DataPage, "columns" | "items">): string[] {
  const names = [...page.columns];
  for (const { row } of page.items) {
    if (row === undefined) continue;
    for (const name of isObject(row) ? Object.keys(row) : ["value"]) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Whether a row is an object of named fields. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One column's value in a row, as `rowColumns` names it. */
export function cellOf(row: unknown, column: string): unknown {
  if (isObject(row)) return row[column];
  return column === "value" ? row : undefined;
}

/** A value as plain text to show in a table, cut to a length a table can hold. */
export function cellText(value: unknown, longest = 200): string {
  if (value === null || value === undefined) return "";
  const whole = typeof value === "string" ? value : JSON.stringify(value);
  return whole.length > longest ? `${whole.slice(0, longest)}…` : whole;
}

/** A number short enough for a table. */
function shortNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : Number(value.toPrecision(5)).toString();
}

/** How many different values a column has, saying when that is only the least there are. */
export function distinctText(column: Pick<DataColumn, "distinct" | "distinctCapped">): string {
  return column.distinctCapped ? `at least ${column.distinct.toLocaleString("en-US")}` : column.distinct.toLocaleString("en-US");
}

/** A column's range of values or lengths, in words. */
export function spanText(column: Pick<DataColumn, "range" | "lengths">): string {
  const span = (low: number, high: number) => (low === high ? shortNumber(low) : `${shortNumber(low)} to ${shortNumber(high)}`);
  const parts: string[] = [];
  if (column.range) parts.push(span(column.range.min, column.range.max));
  if (column.lengths) parts.push(`${span(column.lengths.min, column.lengths.max)} characters`);
  return parts.join("; ");
}

/** The columns an overlap is asked to compare, from what was typed: separated by commas, without empty ones. */
export function parseColumns(typed: string): string[] {
  return typed.split(",").map((column) => column.trim()).filter(Boolean);
}

/** A side of an overlap by name, with its split when it has one. */
export function sideName(side: Pick<DataOverlapSide, "path" | "split">): string {
  return side.split ? `${side.path} (${side.split})` : side.path;
}

/** What an overlap found, in one sentence, saying when its counts are only the least there are. */
export function overlapText(view: DataOverlap): string {
  const least = view.capped ? "at least " : "";
  const compared = view.comparedBy === "columns" ? ` by ${view.columns.join(", ")}` : "";
  if (view.left.inBoth === 0 && view.right.inBoth === 0) {
    return `${view.capped ? "None found so far" : "No identical rows"}${compared}: ${counted(view.left.rows, "row")} and ${counted(view.right.rows, "row")} compared.`;
  }
  return `${least}${counted(view.left.inBoth, "row")} of ${view.left.rows.toLocaleString("en-US")} in ${sideName(view.left)} and ${least}${view.right.inBoth.toLocaleString("en-US")} of ${view.right.rows.toLocaleString("en-US")} in ${sideName(view.right)} are identical${compared}, ${least}${counted(view.sharedDistinct, "different row")} in all.`;
}

/** What could not be compared in an overlap, or nothing when everything was. */
export function overlapLeftOut(view: DataOverlap): string {
  const side = (item: DataOverlapSide) => {
    const parts = [
      item.malformed ? `${counted(item.malformed, "malformed row")}` : "",
      item.tooLong ? `${counted(item.tooLong, "row")} too long` : "",
      item.withoutColumns ? `${counted(item.withoutColumns, "row")} without those columns` : "",
    ].filter(Boolean);
    return parts.length ? `${sideName(item)}: ${parts.join(", ")}` : "";
  };
  const parts = [side(view.left), side(view.right), view.capped ? "The first file had more different rows than are remembered, so the counts are the least there are" : ""].filter(Boolean);
  return parts.length ? `Left out of the comparison. ${parts.join(". ")}.` : "";
}
