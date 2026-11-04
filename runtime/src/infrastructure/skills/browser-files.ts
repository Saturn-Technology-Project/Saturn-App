import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** A folder name for a recording: one plain name under recordings, or a new one when none is given. */
export function recordingName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/[^\w.-]/g, "_").replace(/^\.+/, "") : "";
  return name || `recording-${Date.now().toString(36)}`;
}

/** Where a screenshot goes: under the workspace, also after following links, or refused. */
export async function screenshotPath(dataDir: string, file: string): Promise<string> {
  const workspace = path.resolve(dataDir, "workspace");
  const target = path.resolve(workspace, file);
  const refused = new Error(`A screenshot can only be saved in the workspace (${workspace}).`);
  const within = (root: string, item: string) => item === root || item.startsWith(root + path.sep);
  if (!within(workspace, target) || target === workspace) throw refused;
  // The nearest part of the path that exists says where it really leads; a link to nowhere leads nowhere allowed.
  const root = await realpath(workspace).catch(() => workspace);
  for (let current = target; within(workspace, current); current = path.dirname(current)) {
    const exists = await lstat(current).then(() => true, () => false);
    if (!exists) continue;
    const real = await realpath(current).catch(() => undefined);
    if (!real || !within(root, real)) throw refused;
    break;
  }
  return target;
}
