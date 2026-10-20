import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where the key that encrypts secrets.json is kept. */
export type KeyStoreName = "keychain" | "dpapi" | "libsecret" | "file";

export interface KeyStore {
  readonly name: KeyStoreName;
  /** How the key is protected, for the UI and logs. */
  readonly label: string;
  /** The saved key, or null when there is none yet. Throws when the store cannot be read. */
  get(): Promise<Buffer | null>;
  set(key: Buffer): Promise<void>;
  remove(): Promise<void>;
}

export const KEY_BYTES = 32;
const SERVICE = "Saturn";

/**
 * One key per data folder, so isolated data folders (tests, a second profile) never share or overwrite a key.
 * The account name is derived from the folder's real path.
 */
function account(dataDir: string): string {
  let real = dataDir;
  try {
    real = realpathSync(dataDir);
  } catch {
    // Not created yet: the given path is what later runs will resolve too.
  }
  return `api-keys-${createHash("sha256").update(real).digest("hex").slice(0, 16)}`;
}

function run(file: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

function decodeKey(text: string, encoding: "hex" | "base64"): Buffer | null {
  const key = Buffer.from(text.trim(), encoding);
  return key.length === KEY_BYTES ? key : null;
}

/**
 * macOS Keychain, through the system `security` tool. The key is written on its stdin (`security -i`), never as an
 * argument, so it does not show up in the process list. Items created this way are readable by `security` without a
 * prompt while the login keychain is unlocked.
 */
export function keychainStore(dataDir: string): KeyStore {
  const name = account(dataDir);
  return {
    name: "keychain",
    label: "macOS Keychain",
    async get() {
      const result = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
      if (result.code === 44) return null; // errSecItemNotFound
      if (result.code !== 0) throw new Error(`security find-generic-password failed (${result.code}): ${result.stderr.trim()}`);
      return decodeKey(result.stdout, "hex");
    },
    async set(key) {
      // `security -i` exits non-zero at end of input even after a successful command, so success is read back.
      await run("/usr/bin/security", ["-i"], `add-generic-password -U -s "${SERVICE}" -a "${name}" -l "Saturn API key encryption" -w ${key.toString("hex")}\nquit\n`);
      const saved = await this.get();
      if (!saved?.equals(key)) throw new Error("the Keychain did not keep the key");
    },
    async remove() {
      await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", name]);
    },
  };
}

/** PowerShell that reads one base64 line from stdin, applies DPAPI (current user) and prints base64. */
function dpapiScript(operation: "Protect" | "Unprotect"): string {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$data = [Convert]::FromBase64String([Console]::In.ReadLine())",
    `$out = [Security.Cryptography.ProtectedData]::${operation}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("; ");
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Windows Data Protection API: the key is encrypted with the Windows user's credentials and the result saved as
 * <data>/secrets.dpapi. Only the same Windows user on the same machine can decrypt it. Data goes through stdin.
 */
export function dpapiStore(dataDir: string): KeyStore {
  const file = path.join(dataDir, "secrets.dpapi");
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const call = async (operation: "Protect" | "Unprotect", input: string) => {
    const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", dpapiScript(operation)], `${input}\n`);
    if (result.code !== 0) throw new Error(`DPAPI ${operation} failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
    return result.stdout.trim();
  };
  return {
    name: "dpapi",
    label: "Windows Data Protection (DPAPI)",
    async get() {
      let blob: string;
      try {
        blob = (await readFile(file, "utf8")).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      return decodeKey(await call("Unprotect", blob), "base64");
    },
    async set(key) {
      const blob = await call("Protect", key.toString("base64"));
      await writeFile(file, `${blob}\n`, { mode: 0o600 });
      const saved = await this.get();
      if (!saved?.equals(key)) throw new Error("DPAPI did not return the key");
    },
    async remove() {
      await rm(file, { force: true });
    },
  };
}

/** The Secret Service (GNOME Keyring, KWallet) through `secret-tool`, which reads the secret from stdin. */
export function libsecretStore(dataDir: string): KeyStore {
  const name = account(dataDir);
  const attributes = ["service", SERVICE, "account", name];
  return {
    name: "libsecret",
    label: "Secret Service (libsecret)",
    async get() {
      const result = await run("secret-tool", ["lookup", ...attributes]);
      // Not found: exit 1 with nothing printed. Anything on stderr is a real failure (no Secret Service running, locked).
      if (result.code !== 0 && !result.stderr.trim()) return null;
      if (result.code !== 0) throw new Error(`secret-tool lookup failed: ${result.stderr.trim()}`);
      return decodeKey(result.stdout, "hex");
    },
    async set(key) {
      const result = await run("secret-tool", ["store", "--label=Saturn API key encryption", ...attributes], key.toString("hex"));
      if (result.code !== 0) throw new Error(`secret-tool store failed: ${result.stderr.trim()}`);
      const saved = await this.get();
      if (!saved?.equals(key)) throw new Error("the Secret Service did not keep the key");
    },
    async remove() {
      await run("secret-tool", ["clear", ...attributes]);
    },
  };
}

/**
 * The key in <data>/secrets.key (mode 0600), for systems without an OS key store and for tests. It keeps secrets.json
 * unreadable on its own (a copied or synced file, a pasted log), but anyone who can read the folder has both halves.
 */
export function fileStore(dataDir: string): KeyStore {
  const file = path.join(dataDir, "secrets.key");
  return {
    name: "file",
    label: "key file in the data folder",
    async get() {
      try {
        return decodeKey(await readFile(file, "utf8"), "hex");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async set(key) {
      await writeFile(file, `${key.toString("hex")}\n`, { mode: 0o600 });
    },
    async remove() {
      await rm(file, { force: true });
    },
  };
}

export function keyStore(name: KeyStoreName, dataDir: string): KeyStore {
  switch (name) {
    case "keychain":
      return keychainStore(dataDir);
    case "dpapi":
      return dpapiStore(dataDir);
    case "libsecret":
      return libsecretStore(dataDir);
    case "file":
      return fileStore(dataDir);
  }
}

/** The store for a new key: SATURN_SECRET_STORE when set, otherwise the operating system's own. */
export function preferredKeyStore(dataDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): KeyStore {
  const chosen = env.SATURN_SECRET_STORE?.trim().toLowerCase();
  if (chosen === "keychain" || chosen === "dpapi" || chosen === "libsecret" || chosen === "file") return keyStore(chosen, dataDir);
  if (platform === "darwin") return keychainStore(dataDir);
  if (platform === "win32") return dpapiStore(dataDir);
  return libsecretStore(dataDir);
}

export function newKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

