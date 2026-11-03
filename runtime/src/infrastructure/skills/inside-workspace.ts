import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../../domain/skills/workspace.js";

/**
 * A path as Workspace.resolve gives it, refused when a symbolic link takes it out of the workspace: a cloned repository
 * can bring one that leads to the user's other files. A path that does not exist yet is judged by the folder it would
 * be created in, and a link to nothing is refused, since writing to it would create its target.
 */
export async function insideWorkspace(workspace: Workspace, requested: string): Promise<string> {
  const target = workspace.resolve(requested);
  const root = await realpath(workspace.root);
  let current = target;
  for (;;) {
    let real: string;
    try {
      real = await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      if (await isLink(current)) throw new Error(LEADS_OUT);
      const parent = path.dirname(current);
      if (parent === current) throw new Error(LEADS_OUT);
      current = parent;
      continue;
    }
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error(LEADS_OUT);
    return target;
  }
}

const LEADS_OUT = "Path is outside the workspace (a symbolic link leads out of it)";

async function isLink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}
