import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PatchDocument, splitLines } from "../../domain/skills/patch.js";
import { Workspace } from "../../domain/skills/workspace.js";
import { TEXT_LIMIT, clip, integer, text } from "./text.js";

export class FileSkill {
  constructor(private readonly workspace: Workspace) {}

  async run(args: Record<string, unknown>): Promise<unknown> {
    await mkdir(this.workspace.root, { recursive: true });
    const action = text(args.action || "list");
    if (action === "patch") return this.applyPatch(text(args.patch || args.content));
    const target = this.workspace.resolve(text(args.path || "."));
    if (action === "list") {
      const entries = await readdir(target, { withFileTypes: true });
      return {
        path: this.workspace.relative(target),
        entries: entries.map((item) => ({ name: item.name, kind: item.isDirectory() ? "directory" : "file" })),
      };
    }
    if (action === "read") {
      const content = await readFile(target, "utf8");
      const lines = splitLines(content);
      const offset = Math.max(1, integer(args.offset, 1));
      const limit = args.limit == null ? lines.length : Math.max(1, integer(args.limit, lines.length));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      return { path: this.workspace.relative(target), offset, lines: lines.length, content: clip(slice.join("\n")) };
    }
    if (action === "write") {
      const content = text(args.content);
      if (content.length > TEXT_LIMIT) throw new Error("File is too large");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { path: this.workspace.relative(target), bytes: Buffer.byteLength(content) };
    }
    throw new Error("Use list, read, write, or patch");
  }

  private async applyPatch(patch: string): Promise<unknown> {
    const document = PatchDocument.parse(patch);
    if (!document.changes.length) throw new Error("Patch has no file operations");
    const applied: { path: string; action: string }[] = [];
    for (const change of document.changes) {
      if (change.kind === "add") {
        const target = this.workspace.resolve(change.path);
        if (await exists(target)) throw new Error(`${change.path} already exists`);
        await mkdir(path.dirname(target), { recursive: true });
        const content = `${change.lines.join("\n")}${change.lines.length ? "\n" : ""}`;
        if (content.length > TEXT_LIMIT) throw new Error("File is too large");
        await writeFile(target, content, "utf8");
        applied.push({ path: this.workspace.relative(target), action: "add" });
        continue;
      }
      if (change.kind === "delete") {
        const target = this.workspace.resolve(change.path);
        await rm(target);
        applied.push({ path: this.workspace.relative(target), action: "delete" });
        continue;
      }
      const target = this.workspace.resolve(change.path);
      const source = await readFile(target, "utf8");
      const next = document.apply(source, change.hunks);
      if (next.length > TEXT_LIMIT) throw new Error("File is too large");
      const destination = change.moveTo ? this.workspace.resolve(change.moveTo) : target;
      if (destination !== target) await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, next, "utf8");
      if (destination !== target) await rm(target);
      applied.push({ path: this.workspace.relative(destination), action: change.moveTo ? "move" : "update" });
    }
    return { applied };
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
