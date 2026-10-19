import { HttpError } from "../domain/errors.js";

/** A client stops counting this long after its last heartbeat (Saturn IDE beats every 15 s). */
export const CLIENT_TTL_MS = 45_000;
/** After Saturn opens the IDE, it counts as open this long while it starts up and before its first heartbeat. */
export const LAUNCH_GRACE_MS = 90_000;

export type RuntimeClient = { id: string; kind: string; lastSeen: string };

/**
 * The editor windows (Saturn IDE) using this runtime, known by their heartbeats. The desktop app reads this to
 * decide whether it may quit, and stop the runtime, once it has no window of its own on screen.
 */
export class ClientRegistry {
  private readonly seen = new Map<string, { kind: string; at: number }>();

  beat(id: string, kind: string, now = Date.now()): void {
    const key = String(id ?? "").trim();
    if (!key) throw new HttpError(400, "A client id is required");
    this.seen.set(key, { kind: String(kind || "ide"), at: now });
    // A real heartbeat replaces the placeholder kept while this kind of client was starting.
    this.seen.delete(`starting:${kind}`);
  }

  leave(id: string): void {
    this.seen.delete(String(id));
  }

  /** Saturn just opened a client of this kind: count it as open while it starts. */
  expect(kind: string, now = Date.now()): void {
    this.seen.set(`starting:${kind}`, { kind, at: now + LAUNCH_GRACE_MS - CLIENT_TTL_MS });
  }

  list(now = Date.now()): RuntimeClient[] {
    for (const [id, client] of this.seen) {
      if (now - client.at > CLIENT_TTL_MS) this.seen.delete(id);
    }
    return [...this.seen].map(([id, client]) => ({ id, kind: client.kind, lastSeen: new Date(Math.min(client.at, now)).toISOString() }));
  }
}
