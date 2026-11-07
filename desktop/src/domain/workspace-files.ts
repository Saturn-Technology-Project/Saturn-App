import type { ResearchSession } from "./research.js";

/** Renaming changes the open path, its tab and its draft together, leaving experiment references alone. */
export function renamedFileSession(session: ResearchSession, from: string, to: string): ResearchSession {
  return {
    ...session,
    file: session.file === from ? to : session.file,
    tabs: session.tabs?.map((path) => path === from ? to : path),
    draft: session.draft?.file === from ? { ...session.draft, file: to } : session.draft,
  };
}

/** A new notebook needs its document structure before its editor can open it; other files begin empty. */
export function newFileContent(path: string): string {
  return path.toLowerCase().endsWith(".ipynb")
    ? JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 2) + "\n"
    : "";
}
