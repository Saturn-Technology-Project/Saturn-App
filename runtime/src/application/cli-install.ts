import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Puts the `saturn` command on the user's PATH: a small launcher in ~/.local/bin that runs this runtime's own
 * cli.js with the program that runs the runtime (Saturn's Electron in the app, node in development), so it needs
 * no separate install and always matches the app's version.
 */

export type CliStatus = { path: string; installed: boolean; current: boolean; onPath: boolean; folder: string };

const DEFAULT_PORT = "4700";

function launcherFolder(home = os.homedir()): string {
  return path.join(home, ".local", "bin");
}

function launcherPath(platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  return path.join(launcherFolder(home), platform === "win32" ? "saturn.cmd" : "saturn");
}

/** The CLI entry next to this file: dist/cli.js in the app, src/cli.ts in development. */
function cliEntry(): { file: string; typescript: boolean } {
  const here = fileURLToPath(import.meta.url);
  const typescript = here.endsWith(".ts");
  return { file: path.resolve(path.dirname(here), "..", typescript ? "cli.ts" : "cli.js"), typescript };
}

/** The launcher's text for this platform and this runtime. */
export function launcherScript(options: {
  platform?: NodeJS.Platform;
  exec?: string;
  entry?: { file: string; typescript: boolean };
  electron?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const entry = options.entry ?? cliEntry();
  const env = options.env ?? process.env;
  const exec = options.exec ?? process.execPath;
  const electron = options.electron ?? env.ELECTRON_RUN_AS_NODE === "1";
  // A runtime on another port or data folder (a second Saturn, a test copy) gets a launcher that points at it.
  const extra: Record<string, string> = {};
  if (env.SATURN_RUNTIME_PORT && env.SATURN_RUNTIME_PORT !== DEFAULT_PORT) extra.SATURN_RUNTIME_PORT = env.SATURN_RUNTIME_PORT;
  if (env.SATURN_DATA_DIR) extra.SATURN_DATA_DIR = env.SATURN_DATA_DIR;
  if (electron) extra.ELECTRON_RUN_AS_NODE = "1";
  // The launcher's platform's own path rules, not this machine's: a POSIX path stays POSIX when written on Windows.
  const paths = platform === "win32" ? path.win32 : path.posix;
  const tsx = entry.typescript ? paths.join(paths.dirname(entry.file), "..", "node_modules", "tsx", "dist", "cli.mjs") : "";
  if (platform === "win32") {
    const sets = Object.entries(extra).map(([key, value]) => `@set "${key}=${value}"`).join("\r\n");
    const command = entry.typescript ? `@"${exec}" "${tsx}" "${entry.file}" %*` : `@"${exec}" "${entry.file}" %*`;
    return `@rem Saturn command line: runs the Saturn app's own CLI. Written by Saturn (Settings → General).\r\n@setlocal\r\n${sets ? `${sets}\r\n` : ""}${command}\r\n`;
  }
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const exports = Object.entries(extra).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n");
  const command = entry.typescript ? `exec ${quote(exec)} ${quote(tsx)} ${quote(entry.file)} "$@"` : `exec ${quote(exec)} ${quote(entry.file)} "$@"`;
  return `#!/bin/sh\n# Saturn command line: runs the Saturn app's own CLI. Written by Saturn (Settings → General).\n${exports ? `${exports}\n` : ""}${command}\n`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function cliStatus(): Promise<CliStatus> {
  const file = launcherPath();
  const folder = launcherFolder();
  const installed = await exists(file);
  const current = installed && (await readFile(file, "utf8").catch(() => "")) === launcherScript();
  const onPath = (process.env.PATH ?? "").split(path.delimiter).some((entry) => path.resolve(entry) === folder);
  return { path: file, installed, current, onPath, folder };
}

export async function installCli(): Promise<CliStatus> {
  const file = launcherPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, launcherScript(), "utf8");
  if (process.platform !== "win32") await chmod(file, 0o755);
  return cliStatus();
}
