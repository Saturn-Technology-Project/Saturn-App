import { accessSync, constants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The operating system's sandbox around the `code` tool's commands. `workspace-write` lets a command write only
 * inside the workspace (and the usual temporary and cache folders); `read-only` lets it write nowhere; `off` runs it
 * as the runtime itself. macOS uses seatbelt (`sandbox-exec`), Linux bubblewrap when it is installed; Windows has
 * no sandbox, and the result says so.
 *
 * Seatbelt profiles do not nest: this works because the packaged app (whose Electron runs the runtime) does not
 * carry the App Sandbox entitlement. A build that adds `com.apple.security.app-sandbox` would need another way.
 */
export type SandboxMode = "workspace-write" | "read-only" | "off";

export type SandboxSettings = { mode: SandboxMode; network: boolean };

export const DEFAULT_SANDBOX: SandboxSettings = { mode: "workspace-write", network: true };

export type SandboxPlan = {
  file: string;
  args: string[];
  /** The command runs under the OS sandbox. */
  sandboxed: boolean;
  /** When not sandboxed although a mode asked for it: why. */
  reason?: string;
};

export function sandboxMode(value: unknown): SandboxMode | undefined {
  return value === "workspace-write" || value === "read-only" || value === "off" ? value : undefined;
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function bwrapPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const folder of (env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    const candidate = path.join(folder, "bwrap");
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

/** Whether this computer can sandbox commands at all, and with what. */
export function sandboxSupport(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { available: boolean; tool?: string; reason?: string } {
  if (platform === "darwin") return executable("/usr/bin/sandbox-exec") ? { available: true, tool: "seatbelt" } : { available: false, reason: "sandbox-exec is missing" };
  if (platform === "linux") return bwrapPath(env) ? { available: true, tool: "bubblewrap" } : { available: false, reason: "bubblewrap (bwrap) is not installed" };
  return { available: false, reason: "Windows has no sandbox for commands" };
}

/** The folder with symlinks resolved; a missing one is resolved with the target platform's path rules. */
function real(folder: string, platform: NodeJS.Platform = process.platform): string {
  try {
    return realpathSync(folder);
  } catch {
    return (platform === "win32" ? path.win32 : path.posix).resolve(folder);
  }
}

/** Folders tools cache into under the home folder; writable so npm, pip, cargo and friends keep working. */
function cacheFolders(home: string, platform: NodeJS.Platform): string[] {
  const common = [".npm", ".cache", ".yarn", ".pnpm-store", ".bun", ".cargo/registry", ".cargo/git", ".gradle", ".m2", ".nuget", "go/pkg", ".local/share/pnpm"];
  const extra = platform === "darwin" ? ["Library/Caches"] : [];
  const paths = platform === "win32" ? path.win32 : path.posix;
  return [...common, ...extra].map((item) => paths.join(home, item));
}

/** The folders a command may write to under `workspace-write`: the workspace, temp, and the caches. */
export function writableFolders(root: string, extra: string[] = [], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = env.HOME || os.homedir();
  const folders = [root, ...extra, os.tmpdir(), "/tmp", "/private/tmp", ...(env.TMPDIR ? [env.TMPDIR] : []), ...cacheFolders(home, platform)];
  return [...new Set(folders.map((folder) => real(folder, platform)))];
}

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A seatbelt profile: everything allowed, then writes limited to `writable` (none for read-only), then the network. */
export function seatbeltProfile(mode: Exclude<SandboxMode, "off">, writable: string[], network: boolean): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
  // Pseudo-devices every shell touches.
  lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/") (literal "/dev/dtracehelper"))');
  const allowed = mode === "workspace-write" ? writable : writable.filter((folder) => folder === real(os.tmpdir()) || folder === "/tmp" || folder === "/private/tmp");
  if (allowed.length) lines.push(`(allow file-write* ${allowed.map((folder) => `(subpath ${quote(folder)})`).join(" ")})`);
  // Read-only means the workspace too, even when it sits under a temp folder (the last matching rule wins).
  if (mode === "read-only") lines.push(`(deny file-write* (subpath ${quote(writable[0] ?? "/nonexistent")}))`);
  if (!network) lines.push("(deny network*)", '(allow network* (local unix-socket))');
  return `${lines.join("\n")}\n`;
}

/**
 * Wraps a shell invocation in the sandbox for `settings.mode`. When the platform cannot sandbox, the command runs
 * unwrapped and the plan says why, so the tool result can tell the model and the user.
 */
export function wrapCommand(
  invocation: { file: string; args: string[] },
  settings: SandboxSettings,
  root: string,
  extraWritable: string[] = [],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SandboxPlan {
  if (settings.mode === "off") return { ...invocation, sandboxed: false };
  const support = sandboxSupport(platform, env);
  if (!support.available) return { ...invocation, sandboxed: false, reason: support.reason };
  const writable = writableFolders(root, extraWritable, env, platform);
  if (platform === "darwin") {
    const profile = seatbeltProfile(settings.mode, writable, settings.network);
    return { file: "/usr/bin/sandbox-exec", args: ["-p", profile, invocation.file, ...invocation.args], sandboxed: true };
  }
  // bubblewrap: the whole filesystem read-only, the writable folders bound read-write, no network unless allowed.
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"];
  const allowed = settings.mode === "workspace-write" ? writable : writable.filter((folder) => folder.startsWith("/tmp"));
  for (const folder of allowed) args.push("--bind-try", folder, folder);
  if (!settings.network) args.push("--unshare-net");
  return { file: bwrapPath(env)!, args: [...args, "--", invocation.file, ...invocation.args], sandboxed: true };
}

/** A hint for the model when a sandboxed command failed the way a blocked write or connection fails. */
export function sandboxHint(stderr: string, settings: SandboxSettings): string | undefined {
  const blocked = /operation not permitted|permission denied|read-only file system|EPERM|EACCES|EROFS/i.test(stderr);
  if (blocked) return `(The sandbox allows writes only inside the workspace${settings.mode === "read-only" ? " — none in read-only mode" : ""}. If this command must write elsewhere, call code with sandbox: "off"; that asks the user first.)`;
  if (!settings.network && /could not resolve|network is unreachable|connection refused|ENOTFOUND|ENETUNREACH|ECONNREFUSED|getaddrinfo/i.test(stderr)) {
    return '(The sandbox blocks network access for commands. If this command needs the network, call code with sandbox: "off"; that asks the user first.)';
  }
  return undefined;
}
