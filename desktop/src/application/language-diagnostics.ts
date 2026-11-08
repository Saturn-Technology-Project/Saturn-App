// Newer servers (including TypeScript 7) require diagnostic pulls; older servers publish diagnostics themselves.
import { LSPPlugin, serverDiagnostics, type LSPClient, type LSPClientExtension } from "@codemirror/lsp-client";
import { ViewPlugin } from "@codemirror/view";

/** The exact synchronized document that a diagnostic request inspected. */
interface Snapshot { client: LSPClient; uri: string; version: number; document: object }

/** Versioned diagnostic pulls discard late results rather than putting old errors on new code. */
export class DiagnosticRequests {
  private read: () => Snapshot | null;
  private accept: (snapshot: Snapshot, items: unknown[]) => void;
  private failed: (error: unknown) => void;
  private generation = 0;
  private pending: { snapshot: Snapshot; params: object } | null = null;

  /** Callbacks keep this coordinator testable without a DOM or language server. */
  constructor(read: () => Snapshot | null, accept: (snapshot: Snapshot, items: unknown[]) => void, failed: (error: unknown) => void) {
    this.read = read; this.accept = accept; this.failed = failed;
  }

  /** Changing a document invalidates an in-flight result immediately, before the debounce expires. */
  cancel(): void {
    this.generation++;
    if (this.pending) this.pending.snapshot.client.cancelRequest(this.pending.params);
    this.pending = null;
  }

  /** Request only from a server advertising pulls, and publish only against the same document and version. */
  async refresh(): Promise<void> {
    this.cancel();
    const generation = this.generation, snapshot = this.read();
    const provider = snapshot?.client.serverCapabilities?.diagnosticProvider;
    if (!snapshot || !provider) return;
    const params = { textDocument: { uri: snapshot.uri }, identifier: typeof provider === "object" ? provider.identifier : undefined };
    this.pending = { snapshot, params };
    try {
      const report = await snapshot.client.request<typeof params, { kind: string; items?: unknown[] }>("textDocument/diagnostic", params);
      if (generation !== this.generation) return;
      const current = this.read();
      if (!current || current.document !== snapshot.document || current.version !== snapshot.version || current.client !== snapshot.client) return;
      if (report.kind === "full" && Array.isArray(report.items)) this.accept(snapshot, report.items);
    } catch (error) { if (generation === this.generation) this.failed(error); }
    finally { if (generation === this.generation) this.pending = null; }
  }
}

/** Supplement CodeMirror's push diagnostics with LSP 3.17 pulls and server-requested refreshes. */
export function pullDiagnostics(): LSPClientExtension {
  const refreshers = new Set<() => void>();
  const push = serverDiagnostics().notificationHandlers!["textDocument/publishDiagnostics"];
  return {
    clientCapabilities: { textDocument: { diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false } }, workspace: { diagnostics: { refreshSupport: true } } },
    notificationHandlers: { "workspace/diagnostic/refresh": () => { for (const refresh of refreshers) refresh(); return true; } },
    editorExtension: ViewPlugin.define(view => {
      let timer: ReturnType<typeof setTimeout>;
      const requests = new DiagnosticRequests(() => {
        const plugin = LSPPlugin.get(view);
        if (!plugin || !plugin.client.connected) return null;
        plugin.client.sync();
        const file = plugin.client.workspace.getFile(plugin.uri);
        return file ? { client: plugin.client, uri: plugin.uri, version: file.version, document: view.state.doc } : null;
      }, (snapshot, items) => { push(snapshot.client, { uri: snapshot.uri, version: snapshot.version, diagnostics: items }); }, error => { LSPPlugin.get(view)?.reportError("Diagnostics request failed", error); });
      const schedule = () => { clearTimeout(timer); requests.cancel(); timer = setTimeout(() => { void requests.refresh(); }, 250); };
      refreshers.add(schedule); schedule();
      return { update(update) { if (update.docChanged) schedule(); }, destroy() { clearTimeout(timer); requests.cancel(); refreshers.delete(schedule); } };
    }),
  };
}
