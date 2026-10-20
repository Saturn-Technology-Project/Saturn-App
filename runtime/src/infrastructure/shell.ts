import path from "node:path";

/**
 * Windows variables a program needs to start at all: without SystemRoot many programs (node, git, python)
 * fail to load system DLLs or open sockets, without PATHEXT cmd cannot find `node` from `node.exe`, and
 * TEMP, USERPROFILE and APPDATA are where tools keep their files. Matched case-insensitively.
 */
const WINDOWS_ESSENTIALS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "ALLUSERSPROFILE", "PUBLIC", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS", "PSMODULEPATH",
]);

/** The small environment the `code` tool runs commands with: PATH, plus what Windows itself needs. */
export function commandEnv(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (platform !== "win32") return { PATH: env.PATH || "/usr/bin:/bin" };
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && WINDOWS_ESSENTIALS.has(key.toUpperCase())) result[key] = value;
  }
  return result;
}

/**
 * How to run `command` through the system shell, the way Node's own `shell` option does: on Windows the whole
 * command goes to cmd quoted and verbatim, since cmd does not understand the \" escaping execFile would add.
 */
export function shellInvocation(
  command: string,
  posixShell: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform === "win32") {
    return { file: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true };
  }
  return { file: posixShell, args: ["-c", command], windowsVerbatimArguments: false };
}

/**
 * The Terminal panel's environment. On macOS PATH also gets the Homebrew and system folders a GUI app's PATH
 * lacks; Windows keeps its own PATH (stored as "Path") untouched, since adding a second "PATH" key would shadow it.
 */
export function terminalEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform === "win32") return { ...base, TERM: "xterm-256color" };
  const folders = [base.PATH || "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return { ...base, PATH: folders.join(path.posix.delimiter), TERM: "xterm-256color" };
}
