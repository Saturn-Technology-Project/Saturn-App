export const RUNTIME_ORIGIN = "http://127.0.0.1:4700";
export const SATURN_CLOUD = "https://saturn-backend-629072855899.asia-east1.run.app";

/** HTTP adapter for the local Saturn Runtime. The UI does not call fetch itself. */
export class RuntimeClient {
  constructor(private readonly origin = RUNTIME_ORIGIN) {}

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        const body = JSON.parse(text) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        message = text;
      }
      throw new Error(message);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
