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

  /**
   * Reads a server-sent event stream (fetch, since EventSource cannot send the token) and calls `onEvent` for each
   * event until `signal` aborts or the stream ends; resolves then, rejects when it cannot connect.
   */
  async stream(path: string, onEvent: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void> {
    const response = await this.send(path, { signal, headers: { accept: "text/event-stream" } });
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) {
            try {
              onEvent(event, JSON.parse(data));
            } catch {
              // A malformed event is skipped.
            }
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
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
