import path from "node:path";

/** A directory an agent may read and write. Paths outside it are rejected. */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(requested: string): string {
    const target = path.resolve(this.root, requested);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Path is outside the workspace");
    }
    return target;
  }

  relative(target: string): string {
    return path.relative(this.root, target) || ".";
  }
}
