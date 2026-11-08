// The editor's local language services, and file URIs that never escape a project's source folder.
import type { EditorLanguage } from "./code-languages.ts";

/** A server family; JavaScript and TypeScript share one project service. */
export type ServerLanguage = "python" | "typescript" | "rust";

/** The runtime's description of a process it owns. */
export interface LanguageSession { id: string; server: string; language: ServerLanguage; rootUri: string; python: string | null }

/** Honest connection state shown beside a source file's language. */
export interface LanguageStatus { state: "starting" | "ready" | "unavailable"; server?: string; message?: string }

/** JSON-RPC failures carry a message but are not necessarily JavaScript Error instances. */
export function languageError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

/** Only languages with a real server acquire a connection. */
export function serverLanguage(language: EditorLanguage): ServerLanguage | null {
  if (["javascript", "jsx", "typescript", "tsx"].includes(language)) return "typescript";
  return language === "python" || language === "rust" ? language : null;
}

/** LSP uses distinct IDs for JSX and TSX, even though they share the TypeScript server. */
export function protocolLanguage(language: EditorLanguage): string {
  return language === "jsx" ? "javascriptreact" : language === "tsx" ? "typescriptreact" : language;
}

/** Encode path components separately so spaces, Unicode and literal percent signs survive round trips. */
export function documentUri(root: string, path: string): string {
  if (path.split("/").some(part => part === ".." || part === ".") || path.startsWith("/") || path.includes("\\")) throw new Error("Expected a project-relative source path.");
  return root + path.split("/").map(encodeURIComponent).join("/");
}

/** A definition may be displayed only through the project's ordinary, grant-checked source route. */
export function documentPath(root: string, uri: string): string | null {
  try {
    const base = new URL(root), target = new URL(uri);
    if (target.protocol !== "file:" || base.protocol !== "file:" || target.host !== base.host || target.search || target.hash || !target.pathname.startsWith(base.pathname)) return null;
    const path = decodeURIComponent(target.pathname.slice(base.pathname.length));
    if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some(part => part === ".." || part === ".")) return null;
    return path;
  } catch { return null; }
}

/** The transport depends only on the runtime adapter, which tests can replace with a fake. */
export interface LanguageServerApi {
  startLanguageServer(project: string, language: ServerLanguage): Promise<LanguageSession>;
  sendLanguageMessages(project: string, session: string, messages: unknown[]): Promise<unknown>;
  languageEvents(project: string, session: string, after: number | null, receive: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void>;
  stopLanguageServer(project: string, session: string): Promise<unknown>;
}
