import diagnostics from "node:diagnostics_channel";
import { appendFile, rename, stat } from "node:fs/promises";
import path from "node:path";

/** One request the runtime sent. Query strings are dropped (some APIs put keys there); bodies are never read. */
export type NetworkEntry = { at: string; method: string; host: string; path: string; local: boolean };

/** Every host the runtime has talked to since it started. */
export type NetworkHost = { host: string; local: boolean; requests: number; first: string; last: string; methods: string[] };

const RECENT = 500;
const FILE_LIMIT = 5 * 1024 * 1024;

/**
 * A record of every HTTP(S) request the runtime makes, from Node's own diagnostics channels (fetch/undici and the
 * http/https modules), so it covers the model SDKs, the tools and anything else in the process without each one
 * reporting itself. Kept in memory for the Telemetry page and appended to `<data>/network.log` (JSON lines) for
 * `tail -f`. Programs the runtime starts (Claude Code, Codex, git) are separate processes and are not in it.
 */
export class NetworkLog {
  private readonly recent: NetworkEntry[] = [];
  private readonly hosts = new Map<string, NetworkHost>();
  private file: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Node holds channels weakly: without these references a subscription can be collected and go quiet. */
  private readonly channels: diagnostics.Channel[] = [];

  start(dataDir: string): void {
    this.file = path.join(dataDir, "network.log");
    const undici = diagnostics.channel("undici:request:create");
    const http = diagnostics.channel("http.client.request.start");
    this.channels.push(undici, http);
    undici.subscribe((message) => {
      const request = (message as { request?: { origin?: unknown; method?: unknown; path?: unknown } }).request;
      if (!request) return;
      try {
        const url = new URL(String(request.path ?? "/"), String(request.origin));
        this.note(String(request.method ?? "GET"), url);
      } catch {
        // An origin undici accepted but URL cannot parse: nothing useful to record.
      }
    });
    http.subscribe((message) => {
      const request = (message as { request?: { method?: unknown; host?: unknown; path?: unknown; protocol?: unknown; getHeader?: (name: string) => unknown } }).request;
      if (!request) return;
      try {
        const protocol = String(request.protocol ?? "http:");
        // The Host header carries the port the request goes to; `host` alone does not.
        const host = String(request.getHeader?.("host") ?? request.host ?? "");
        this.note(String(request.method ?? "GET"), new URL(`${protocol}//${host}${String(request.path ?? "/")}`));
      } catch {
        // As above.
      }
    });
  }

  private note(method: string, url: URL): void {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const local = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    const entry: NetworkEntry = { at: new Date().toISOString(), method: method.toUpperCase(), host: url.host, path: url.pathname, local };
    this.recent.push(entry);
    if (this.recent.length > RECENT) this.recent.shift();
    const known = this.hosts.get(entry.host);
    if (known) {
      known.requests += 1;
      known.last = entry.at;
      if (!known.methods.includes(entry.method)) known.methods.push(entry.method);
    } else {
      this.hosts.set(entry.host, { host: entry.host, local, requests: 1, first: entry.at, last: entry.at, methods: [entry.method] });
    }
    this.persist(entry);
  }

  private persist(entry: NetworkEntry): void {
    const file = this.file;
    if (!file) return;
    this.writing = this.writing
      .then(async () => {
        const size = await stat(file).then((info) => info.size, () => 0);
        if (size > FILE_LIMIT) await rename(file, `${file}.1`).catch(() => undefined);
        await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      })
      .catch(() => undefined);
  }

  /** Hosts by most recent use, and the latest requests, newest first. */
  view(limit = 200): { since: string; hosts: NetworkHost[]; recent: NetworkEntry[]; file: string | null } {
    return {
      since: STARTED,
      hosts: [...this.hosts.values()].sort((a, b) => b.last.localeCompare(a.last)),
      recent: this.recent.slice(-limit).reverse(),
      file: this.file,
    };
  }
}

const STARTED = new Date().toISOString();

export const networkLog = new NetworkLog();
