export const RUNTIME_ORIGIN = "http://127.0.0.1:4700";

/** The session token the desktop preload exposes; the runtime rejects requests without it. Read once, then cached. */
let cachedToken: string | null = null;
function runtimeToken(): string {
  if (cachedToken !== null) return cachedToken;
  const token = (globalThis as { saturnDesktop?: { runtimeToken?: () => string } }).saturnDesktop?.runtimeToken?.() ?? "";
  // In a plain browser (no desktop preload) there is no token; keep re-reading until the bridge appears.
  if (token) cachedToken = token;
  return token;
}

/** HTTP adapter for the local Saturn Runtime. The UI does not call fetch itself. */
export class RuntimeClient {
  constructor(private readonly origin = RUNTIME_ORIGIN) {}

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.send(path, init);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  /** Fetches a file the runtime offers as a download, with the name it suggests. */
  async download(path: string): Promise<{ blob: Blob; filename: string }> {
    const response = await this.send(path);
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "download";
    return { blob: await response.blob(), filename };
  }

  private async send(path: string, init?: RequestInit): Promise<Response> {
    const token = runtimeToken();
    const response = await fetch(`${this.origin}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text.trim() || `Saturn Runtime returned ${response.status}`;
      try {
        const body = JSON.parse(text) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Express's own HTML page ("Cannot POST /path") means the route is missing: the runtime is older than this app.
        const missing = /Cannot (GET|POST|PUT|PATCH|DELETE) ([^<\s]+)/.exec(text);
        if (missing) {
          message = `The Saturn Runtime on this computer is out of date (it has no ${missing[1]} ${missing[2]}). Restart Saturn, or restart the runtime in development.`;
        } else if (/<html/i.test(text)) {
          message = `Saturn Runtime returned ${response.status} ${response.statusText}`.trim();
        }
      }
      throw new Error(message);
    }
    return response;
  }
}
