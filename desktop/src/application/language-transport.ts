// Ordered HTTP writes and replayable server events implement CodeMirror's small transport interface.
import type { LanguageServerApi } from "../domain/language-server.ts";

/** One authenticated session, with errors surfaced instead of silently dropping document changes. */
export class LanguageTransport {
  private listeners = new Set<(message: string) => void>();
  private controller = new AbortController();
  private sending: Promise<unknown> = Promise.resolve();
  private started = false;
  private closed = false;
  private after: number | null = null;
  private pending = 0;
  private api: LanguageServerApi;
  private project: string;
  private session: string;
  private failed: (message: string) => void;

  /** Connect to a process already created by the runtime; no token leaves runtime-client. */
  constructor(api: LanguageServerApi, project: string, session: string, failed: (message: string) => void) {
    this.api = api; this.project = project; this.session = session; this.failed = failed;
  }

  /** Chain writes so a request always follows the document changes it is meant to inspect. */
  send(message: string): void {
    if (this.closed) throw new Error("The language-server connection is closed.");
    if (++this.pending > 128) { this.fail("The language server is not keeping up with document changes."); return; }
    const parsed: unknown = JSON.parse(message);
    this.sending = this.sending.then(() => {
      if (this.closed) return;
      return this.api.sendLanguageMessages(this.project, this.session, [parsed]);
    }).catch(error => this.fail(error instanceof Error ? error.message : String(error))).finally(() => { this.pending--; });
  }

  /** Subscribe before initialization; server-side replay covers a stream that connects a moment later. */
  subscribe(listener: (message: string) => void): void {
    this.listeners.add(listener);
    if (this.started) return;
    this.started = true;
    void this.api.languageEvents(this.project, this.session, this.after, (event, data) => {
      if (this.closed || event !== "lsp" || !data || typeof data !== "object") return;
      const record = data as { seq?: number; message?: unknown; closed?: boolean; reason?: string };
      if (record.closed) { this.fail(record.reason ?? "The language server stopped."); return; }
      if (typeof record.seq !== "number" || record.seq <= (this.after ?? -1)) return;
      if (record.seq !== (this.after ?? -1) + 1) { this.fail("Language-server messages were missed. Restart the connection."); return; }
      this.after = record.seq;
      for (const hear of this.listeners) hear(JSON.stringify(record.message));
    }, this.controller.signal).then(() => {
      if (!this.closed) this.fail("The language-server event stream ended. Restart the connection.");
    }).catch(error => { if (!this.closed) this.fail(error instanceof Error ? error.message : String(error)); });
  }

  /** Detach a client's receiver; the owning workspace explicitly closes the transport. */
  unsubscribe(listener: (message: string) => void): void { this.listeners.delete(listener); }

  /** Abort the stream and prevent queued messages from being sent to a replaced process. */
  close(): void { this.closed = true; this.controller.abort(); this.listeners.clear(); }

  /** Fail once, keeping the UI's connection state in step with the transport. */
  private fail(message: string): void { if (this.closed) return; this.close(); this.failed(message); }
}
