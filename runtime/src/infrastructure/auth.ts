import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The file that holds the runtime's session token, readable only by the user who runs Saturn. */
export function tokenFile(dataDir: string): string {
  return path.join(dataDir, "runtime-token");
}

/**
 * The shared secret every local client (the desktop UI, the Electron main process, Saturn IDE) must present
 * to the runtime. It is generated once and kept at 0600 in the data dir, so only this user's processes can
 * read it; a web page or another user cannot. It is reused across restarts so a running IDE keeps working.
 */
export function loadOrCreateToken(dataDir: string): string {
  // A token supplied by the launcher (the desktop passes one when it spawns the runtime) wins, so the two
  // agree without a file-read race. It is still written to the file below for clients that read it directly.
  const fromEnv = process.env.SATURN_RUNTIME_TOKEN?.trim();
  const file = tokenFile(dataDir);
  if (fromEnv && fromEnv.length >= 32) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, fromEnv, { mode: 0o600 });
    } catch {
      // The env token still works even if it cannot be mirrored to disk.
    }
    return fromEnv;
  }
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // No token yet (or unreadable): make a fresh one below.
  }
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** Constant-time compare, so a wrong token cannot be guessed byte by byte from timing. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
