// Keep a server disappearing during initialization from leaving CodeMirror waiting forever for the old handshake.
import { LSPClient, type LSPClientConfig, type Transport } from "@codemirror/lsp-client";

/** Closing cancels UI queries without allowing a stopped process to put an error on its replacement. */
export class SourceLanguageClient extends LSPClient {
  private output: Transport | null = null;
  private reason: string | null = null;
  private finish!: () => void;
  private ended = new Promise<void>(resolve => { this.finish = resolve; });
  private pending = new Set<() => void>();

  /** Use the official client for protocol handling and position mapping. */
  constructor(config: LSPClientConfig) { super(config); }

  /** Remember the public transport for notifications, without accessing the client's private request bookkeeping. */
  override connect(transport: Transport): this { this.output = transport; return super.connect(transport); }

  /** A disconnected official client can still retain its transport object; that is not a live connection. */
  override get connected(): boolean { return this.reason === null && super.connected; }

  /** Fail initialization immediately if the process ends before it sends an initialize response. */
  async ready(): Promise<void> {
    await Promise.race([this.initializing, this.ended.then(() => { throw new Error(this.reason ?? "The language server stopped."); })]);
  }

  /** Cancel queued notifications on close, including ones waiting for an initialization that cannot finish. */
  override notification<Params>(method: string, params: Params): void {
    if (this.reason !== null) return;
    void this.initializing.then(() => {
      if (this.reason === null) this.output?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    }).catch(() => {});
  }

  /** A pending hover, completion or navigation must not outlive its process or put an error on its replacement. */
  override request<Params, Result>(method: string, params: Params): Promise<Result> {
    if (this.reason !== null) return Promise.resolve(null as Result);
    let cancel!: () => void;
    const cancelled = new Promise<Result>(resolve => { cancel = () => resolve(null as Result); });
    this.pending.add(cancel);
    return Promise.race([super.request<Params, Result>(method, params), cancelled]).catch(error => {
      if (this.reason !== null) return null as Result;
      throw error;
    }).finally(() => { this.pending.delete(cancel); });
  }

  /** Let the original initialization promise settle before the official disconnect replaces it. */
  stop(reason: string): void {
    if (this.reason !== null) return;
    this.reason = reason;
    this.workspace.disconnected();
    this.finish();
    for (const cancel of this.pending) cancel();
    this.pending.clear();
    void this.initializing.then(() => super.disconnect(), () => super.disconnect());
  }

  /** Closing a project and explicit restarts use the same bounded shutdown behavior as transport failures. */
  override disconnect(): void { this.stop("The language-server connection closed."); }
}
