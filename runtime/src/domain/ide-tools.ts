import type { McpConnection, ToolRoute } from "./model.js";

export const IDE_ID = "ide";
export const IDE_URL = "builtin://ide";

const tool = (toolId: string, category: "read" | "write", description: string, properties: Record<string, unknown>, required: string[] = []): ToolRoute => ({
  toolId,
  serverId: IDE_ID,
  category,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  environments: ["production"],
});

const AT = {
  path: { type: "string", description: "The file, relative to the project folder." },
  symbol: { type: "string", description: "The identifier to look up, exactly as written in the file." },
  line: { type: "integer", description: "1-based line where the symbol appears, when it appears more than once (optional)." },
};

/**
 * The editor's language servers, through Saturn IDE when it has the project open: what the compiler says is
 * wrong, where a symbol is defined and used, its type, and a rename that updates every reference. Only listed
 * for a chat whose project is open in Saturn IDE.
 */
export const IDE_TOOLS: ToolRoute[] = [
  tool("ide_diagnostics", "read", "The errors and warnings the editor's language servers report (TypeScript, ESLint, Pyright…), for one file or the whole project. Check this after editing code.", {
    path: { type: "string", description: "One file, relative to the project folder; omit for every file with problems." },
    severity: { type: "string", enum: ["error", "warning", "all"], description: "Default: error and warning." },
  }),
  tool("ide_definition", "read", "Where a symbol is defined (follows imports into other files and dependencies), with the code around it.", AT, ["path", "symbol"]),
  tool("ide_references", "read", "Every place a symbol is used across the project, as the language server resolves it (not a text search).", AT, ["path", "symbol"]),
  tool("ide_hover", "read", "A symbol's type signature and documentation, as the editor shows it on hover.", AT, ["path", "symbol"]),
  tool("ide_symbols", "read", "Find functions, classes, types and variables by name across the project.", {
    query: { type: "string", description: "Part of the symbol's name." },
  }, ["query"]),
  tool("ide_rename", "write", "Rename a symbol and update every reference to it across the project, as the editor's Rename Symbol does.", {
    ...AT,
    newName: { type: "string", description: "The new name." },
  }, ["path", "symbol", "newName"]),
];

export function ideSkills(): McpConnection {
  return { id: IDE_ID, name: "Saturn IDE", url: IDE_URL, tools: IDE_TOOLS };
}
