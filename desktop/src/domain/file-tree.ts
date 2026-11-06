// The Workspace's file tree as data: which folders are open, what each folder holds once read, and the rows that
// shows, in order. The screen reads folders through the runtime and draws the rows; every decision is made here.

/** One thing in a folder, as the runtime lists it. */
export interface TreeEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

/** What the tree knows: each read folder's entries by its path ("." is the project), and which folders are open. */
export interface TreeState {
  folders: Readonly<Record<string, readonly TreeEntry[]>>;
  open: readonly string[];
}

/** A row of the tree as shown. */
export interface TreeRow {
  entry: TreeEntry;
  /** 1 for the project's own entries. */
  depth: number;
  /** For a folder: whether it is open. */
  expanded: boolean;
  /** For an open folder whose entries are not read yet. */
  loading: boolean;
  /** Folders a project fills by itself (installs, caches, builds): shown faded and never opened for you. */
  generated: boolean;
}

/** Folders tools make and refill, which are rarely what a person is looking for. */
const GENERATED = new Set([
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".ipynb_checkpoints",
  ".tox",
  ".cache",
  "target",
  "dist",
  "build",
  "wandb",
  "mlruns",
  ".DS_Store",
]);

/** The empty tree, with nothing read and nothing open. */
export const EMPTY_TREE: TreeState = { folders: {}, open: [] };

/** Whether an entry is one a project's tools generate. */
export function isGenerated(entry: TreeEntry): boolean {
  return GENERATED.has(entry.name);
}

/** Folders before files; then names as a person reads them: case aside, numbers by value, dot files last. */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    const leftHidden = left.name.startsWith(".");
    const rightHidden = right.name.startsWith(".");
    if (leftHidden !== rightHidden) return leftHidden ? 1 : -1;
    return collator.compare(left.name, right.name) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  });
}

/** The folders that hold a path, from the project's down: "a/b/c.py" is in "a" and "a/b". */
export function ancestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** The folder a path is in ("." for the project's own). */
export function parentOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

/** The tree with a folder's entries read; entries the runtime keeps to itself are left out. */
export function withFolder(state: TreeState, path: string, entries: readonly TreeEntry[]): TreeState {
  const shown = sortEntries(entries.filter((entry) => entry.path !== ".saturn" && !entry.path.startsWith(".saturn/")));
  return { ...state, folders: { ...state.folders, [path]: shown } };
}

/** The tree with a folder opened or closed. */
export function toggled(state: TreeState, path: string, open?: boolean): TreeState {
  const isOpen = state.open.includes(path);
  const next = open ?? !isOpen;
  if (next === isOpen) return state;
  return { ...state, open: next ? [...state.open, path] : state.open.filter((item) => item !== path) };
}

/** The tree with every folder that holds a path open, so the path shows. */
export function revealed(state: TreeState, path: string): TreeState {
  const missing = ancestors(path).filter((folder) => !state.open.includes(folder));
  return missing.length ? { ...state, open: [...state.open, ...missing] } : state;
}

/** The open folders whose entries still have to be read, parents first. */
export function foldersToRead(state: TreeState): string[] {
  return [".", ...state.open].filter((path) => !state.folders[path] && isReachable(state, path));
}

/** Whether every folder that holds a path is open, so reading it would show something. */
function isReachable(state: TreeState, path: string): boolean {
  return path === "." || ancestors(path).every((folder) => state.open.includes(folder));
}

/**
 * The tree after its folders were read again: folders that are gone are forgotten and closed, and their entries with
 * them. `read` holds what was read now; a folder missing from it is gone.
 */
export function refreshed(state: TreeState, read: Readonly<Record<string, readonly TreeEntry[] | null>>): TreeState {
  let next: TreeState = { folders: { ...state.folders }, open: state.open };
  const gone = new Set<string>();
  for (const [path, entries] of Object.entries(read)) {
    if (entries) next = withFolder(next, path, entries);
    else gone.add(path);
  }
  const isGone = (path: string) => [...gone].some((folder) => path === folder || path.startsWith(`${folder}/`));
  const folders = Object.fromEntries(Object.entries(next.folders).filter(([path]) => !isGone(path)));
  return { folders, open: next.open.filter((path) => !isGone(path)) };
}

/** The rows the tree shows, in order: each folder's entries under it while it is open. */
export function treeRows(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const add = (folder: string, depth: number) => {
    for (const entry of state.folders[folder] ?? []) {
      const expanded = entry.kind === "directory" && state.open.includes(entry.path);
      rows.push({ entry, depth, expanded, loading: expanded && !state.folders[entry.path], generated: isGenerated(entry) });
      if (expanded) add(entry.path, depth + 1);
    }
  };
  add(".", 1);
  return rows;
}

/** A key pressed on a row, and what it does, as the tree pattern for assistive technology defines it. */
export type TreeMove =
  | { kind: "focus"; index: number }
  | { kind: "toggle"; path: string; open: boolean }
  | { kind: "open-file"; path: string }
  | { kind: "none" };

/** What a key does on the row at `index`. */
export function keyMove(rows: readonly TreeRow[], index: number, key: string): TreeMove {
  const row = rows[index];
  if (!row) return rows.length ? { kind: "focus", index: 0 } : { kind: "none" };
  const isFolder = row.entry.kind === "directory";
  switch (key) {
    case "ArrowDown":
      return index + 1 < rows.length ? { kind: "focus", index: index + 1 } : { kind: "none" };
    case "ArrowUp":
      return index > 0 ? { kind: "focus", index: index - 1 } : { kind: "none" };
    case "Home":
      return { kind: "focus", index: 0 };
    case "End":
      return { kind: "focus", index: rows.length - 1 };
    case "ArrowRight":
      if (!isFolder) return { kind: "none" };
      if (!row.expanded) return { kind: "toggle", path: row.entry.path, open: true };
      return rows[index + 1]?.depth === row.depth + 1 ? { kind: "focus", index: index + 1 } : { kind: "none" };
    case "ArrowLeft": {
      if (isFolder && row.expanded) return { kind: "toggle", path: row.entry.path, open: false };
      const parent = parentOf(row.entry.path);
      const at = rows.findIndex((item) => item.entry.path === parent);
      return at >= 0 ? { kind: "focus", index: at } : { kind: "none" };
    }
    case "Enter":
    case " ":
      return isFolder ? { kind: "toggle", path: row.entry.path, open: !row.expanded } : { kind: "open-file", path: row.entry.path };
    default:
      return { kind: "none" };
  }
}
