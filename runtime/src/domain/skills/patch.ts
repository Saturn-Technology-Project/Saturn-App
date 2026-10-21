type Hunk = { old: string[]; next: string[] };

export type FileChange =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] };

/** The apply_patch document: Begin/End Patch, Add, Delete, Update, and Move. */
export class PatchDocument {
  private constructor(readonly changes: FileChange[]) {}

  static parse(raw: string): PatchDocument {
    const lines = raw.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    if (!lines[0]?.startsWith("*** Begin Patch")) throw new Error("Patch must start with *** Begin Patch");
    const changes: FileChange[] = [];
    let index = 1;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.trim() === "*** End Patch") return new PatchDocument(changes);
      if (line.startsWith("*** Add File: ")) {
        const file = line.slice("*** Add File: ".length).trim();
        index += 1;
        const body: string[] = [];
        while (index < lines.length && (lines[index] ?? "").startsWith("+")) {
          body.push((lines[index] ?? "").slice(1));
          index += 1;
        }
        changes.push({ kind: "add", path: file, lines: body });
        continue;
      }
      if (line.startsWith("*** Delete File: ")) {
        changes.push({ kind: "delete", path: line.slice("*** Delete File: ".length).trim() });
        index += 1;
        continue;
      }
      if (line.startsWith("*** Update File: ")) {
        const file = line.slice("*** Update File: ".length).trim();
        index += 1;
        let moveTo: string | undefined;
        if ((lines[index] ?? "").startsWith("*** Move to: ")) {
          moveTo = (lines[index] ?? "").slice("*** Move to: ".length).trim();
          index += 1;
        }
        const hunks: Hunk[] = [];
        while ((lines[index] ?? "").startsWith("@@")) {
          index += 1;
          const old: string[] = [];
          const next: string[] = [];
          while (index < lines.length && !(lines[index] ?? "").startsWith("***") && !(lines[index] ?? "").startsWith("@@")) {
            const row = lines[index] ?? "";
            if (row === "*** End of File") {
              index += 1;
              break;
            }
            if (row === "") {
              // A blank context line whose leading space was dropped (models often do).
              old.push("");
              next.push("");
            } else if (row.startsWith("+")) next.push(row.slice(1));
            else if (row.startsWith("-")) old.push(row.slice(1));
            else if (row.startsWith(" ")) {
              old.push(row.slice(1));
              next.push(row.slice(1));
            } else throw new Error("A patch line must start with a space, + or -");
            index += 1;
          }
          hunks.push({ old, next });
        }
        if (!hunks.length && !moveTo) throw new Error(`Update for ${file} has no hunk`);
        changes.push({ kind: "update", path: file, moveTo, hunks });
        continue;
      }
      throw new Error(`Unknown patch line: ${line}`);
    }
    // A patch complete but for its closing line: models often drop it, and nothing is ambiguous without it.
    if (changes.length) return new PatchDocument(changes);
    throw new Error("Patch must end with *** End Patch");
  }

  apply(source: string, hunks: Hunk[]): string {
    const ended = source.endsWith("\n");
    const lines = splitLines(source);
    let cursor = 0;
    for (const hunk of hunks) {
      if (!hunk.old.length) {
        lines.splice(cursor, 0, ...hunk.next);
        cursor += hunk.next.length;
        continue;
      }
      const at = findSequence(lines, hunk.old, cursor);
      if (at < 0) throw new Error("Patch context was not found");
      lines.splice(at, hunk.old.length, ...hunk.next);
      cursor = at + hunk.next.length;
    }
    const text = lines.join("\n");
    return ended || source === "" ? `${text}${text.endsWith("\n") ? "" : "\n"}` : text;
  }
}

function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (content.endsWith("\n") || content.endsWith("\r\n")) lines.pop();
  return lines;
}

function findSequence(lines: string[], needle: string[], start: number): number {
  for (let index = start; index <= lines.length - needle.length; index += 1) {
    if (needle.every((line, offset) => lines[index + offset] === line)) return index;
  }
  return -1;
}

export { splitLines };
