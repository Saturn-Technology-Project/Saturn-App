import { createHash } from "node:crypto";
import path from "node:path";
import { HttpError } from "../domain/errors.js";
import type { McpCommand, McpConnection } from "../domain/model.js";
import { commandEnv, terminalEnv } from "../infrastructure/shell.js";

/**
 * Local MCP servers: programs Saturn starts on this computer and talks to over stdio (`npx -y @scope/server …`,
 * `uvx mcp-server-git`, a script). Nothing starts until the user has seen the exact command and allowed it; the
 * approval is a fingerprint of program, arguments and environment, so any change asks again.
 */

/** Where an environment variable's value is kept: the encrypted secrets file, never state.json. */
export const envSecretKey = (id: string) => `mcp:${id}:env`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Checks and normalizes what the user typed: a program, its arguments, and environment variables. */
export function parseCommand(input: unknown): { command: McpCommand; env: Record<string, string> } {
  const value = (input ?? {}) as { program?: unknown; args?: unknown; env?: unknown };
  const program = typeof value.program === "string" ? value.program.trim() : "";
  if (!program) throw new HttpError(400, "A local MCP server needs the program to run, for example npx or uvx.");
  if (/[\r\n\0]/.test(program)) throw new HttpError(400, "The program name contains a line break.");
  const args = Array.isArray(value.args) ? value.args : [];
  if (!args.every((arg) => typeof arg === "string")) throw new HttpError(400, "Arguments must be text.");
  if (args.some((arg) => /[\0]/.test(arg as string))) throw new HttpError(400, "An argument contains a NUL character.");
  const env: Record<string, string> = {};
  for (const [name, val] of Object.entries((value.env ?? {}) as Record<string, unknown>)) {
    if (!ENV_NAME.test(name)) throw new HttpError(400, `"${name}" is not a valid environment variable name.`);
    if (typeof val !== "string") throw new HttpError(400, `The value of ${name} must be text.`);
    env[name] = val;
  }
  return { command: { program, args: args as string[], env: Object.keys(env).sort() }, env };
}

/** The fingerprint the user approves: program, arguments, and every environment variable with its value. */
export function commandFingerprint(command: McpCommand, env: Record<string, string>): string {
  const entries = Object.keys(env).sort().map((name) => [name, env[name]]);
  return createHash("sha256").update(JSON.stringify([command.program, command.args, entries])).digest("hex");
}

/** How the command reads in a terminal, for the approval card. Arguments with spaces or quotes are quoted. */
export function commandLine(command: McpCommand): string {
  const quote = (part: string) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`);
  return [command.program, ...command.args].map(quote).join(" ");
}

/** A readable placeholder for the connection's url field, which every MCP connection has. */
export function commandAddress(command: McpCommand): string {
  return `stdio:${path.basename(command.program)}`;
}

/**
 * The environment the program starts with. The MCP SDK adds only a short allowlist of the runtime's variables
 * (HOME, USER, SHELL, TERM, LOGNAME on macOS; the system ones on Windows), so Saturn's own environment, including
 * any API keys in it, never reaches the server. Saturn adds a PATH that finds npx and uvx when it was started from
 * the Dock (Homebrew's folders on macOS), and the variables the user set for this server.
 */
export function serverEnvironment(env: Record<string, string>, platform: NodeJS.Platform = process.platform, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const extra: Record<string, string> = {};
  if (platform === "win32") {
    for (const [key, value] of Object.entries(commandEnv(platform, base))) if (value !== undefined) extra[key] = value;
  } else {
    extra.PATH = terminalEnv({ PATH: base.PATH ?? "" }, platform).PATH ?? "/usr/bin:/bin";
  }
  return { ...extra, ...env };
}

/** What Settings shows about a local server: its command line, variable names, and whether it may run. */
export function commandView(connection: McpConnection, env: Record<string, string>) {
  if (!connection.command) return {};
  const fingerprint = commandFingerprint(connection.command, env);
  return {
    commandLine: commandLine(connection.command),
    commandFingerprint: fingerprint,
    approval: connection.approvedCommand === fingerprint ? ("approved" as const) : ("needed" as const),
  };
}

/** Raised when a local server would start but its current command has not been allowed. */
export class CommandNotApproved extends HttpError {
  constructor(readonly connectionName: string, readonly line: string) {
    super(409, `The MCP server "${connectionName}" runs a program on this computer (${line}). Allow it in Saturn Settings → MCP Servers before it can start.`);
  }
}
