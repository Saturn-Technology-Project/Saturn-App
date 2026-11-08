// A workspace owns one connection per server family. Editors come and go while unsaved imported files stay open to LSP.
import DOMPurify from "dompurify";
import { hoverTooltips, jumpToDefinitionKeymap, LSPClient, LSPPlugin, serverCompletion, serverDiagnostics, signatureHelp, Workspace, type WorkspaceFile } from "@codemirror/lsp-client";
import { Compartment, StateEffect, Text } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import type { EditorLanguage } from "../domain/code-languages.ts";
import { t } from "../domain/i18n.ts";
import { documentPath, documentUri, isLibraryPath, languageError, LIBRARY_PREFIX, protocolLanguage, serverLanguage, type LanguageServerApi, type LanguageSession, type LanguageStatus, type ServerLanguage } from "../domain/language-server.ts";
import { LanguageTransport } from "./language-transport.ts";
import { pullDiagnostics } from "./language-diagnostics.ts";
import { SourceLanguageClient } from "./language-client.ts";

/** One source buffer, also retained when its editor tab is not visible. */
class SourceFile implements WorkspaceFile {
  uri: string;
  languageId: string;
  version = 0;
  doc: Text;
  view: EditorView | null;
  /** Keep the last synchronized document independently of an editor's lifetime. */
  constructor(uri: string, languageId: string, doc: Text, view: EditorView | null = null) { this.uri = uri; this.languageId = languageId; this.view = view; this.doc = doc; }
  /** A closed tab still has a buffer, but no active view. */
  getView(): EditorView | null { return this.view; }
}

/** A CodeMirror workspace that preserves unsaved imports across file switches. */
export class SourceWorkspace extends Workspace {
  files: SourceFile[] = [];
  private display: (uri: string) => Promise<EditorView | null>;
  /** Definitions are displayed through the same grant-checked file opening flow as tree clicks. */
  constructor(client: LSPClient, display: (uri: string) => Promise<EditorView | null>) { super(client); this.display = display; }

  /** Record real changes and monotonically increasing versions before semantic requests. */
  syncFiles() {
    const updates = [];
    for (const file of this.files) {
      if (!file.view) continue;
      const plugin = LSPPlugin.get(file.view);
      if (!plugin || plugin.unsyncedChanges.empty) continue;
      updates.push({ file, prevDoc: file.doc, changes: plugin.unsyncedChanges });
      file.doc = file.view.state.doc;
      file.version++;
      plugin.clear();
    }
    return updates;
  }

  /** Reattach with a fresh open notification: push-only servers must resend diagnostics to the new editor view. */
  openFile(uri: string, languageId: string, view: EditorView): void {
    let file = this.files.find(file => file.uri === uri);
    if (!file) {
      file = new SourceFile(uri, languageId, view.state.doc, view);
      this.files.push(file);
      this.client.didOpen(file);
    } else {
      this.client.didClose(uri);
      file.doc = view.state.doc; file.version++;
      file.view = view;
      this.client.didOpen(file);
    }
  }

  /** Restore an unsaved, inactive import after restarting a language server. */
  seed(uri: string, languageId: string, doc: Text): void { if (!this.getFile(uri)) this.files.push(new SourceFile(uri, languageId, doc)); }

  /** Send the final unsaved contents before the view is destroyed, retaining them for imported-file inference. */
  closeFile(uri: string, view: EditorView): void {
    const file = this.files.find(file => file.uri === uri);
    if (!file || file.view !== view) return;
    if (!file.doc.eq(view.state.doc)) {
      file.doc = view.state.doc; file.version++;
      if (this.client.connected) this.client.notification("textDocument/didChange", { textDocument: { uri, version: file.version }, contentChanges: [{ text: file.doc.toString() }] });
    }
    file.view = null;
  }

  /** Closing or renaming a tab releases its overlay, so discarded edits cannot influence another file. */
  forget(uri: string): void {
    if (!this.getFile(uri)) return;
    this.files = this.files.filter(file => file.uri !== uri);
    if (this.client.connected) this.client.didClose(uri);
  }

  /** Put a definition in front of the person, preserving every other file's unsaved buffer. */
  override displayFile(uri: string): Promise<EditorView | null> { return this.display(uri); }
}

/** One initialized client and its runtime process. */
interface Connection { client: SourceLanguageClient; transport: LanguageTransport; session: LanguageSession; dead?: string }
/** An attached source view and the compartment replaced when its language server restarts. */
interface Binding { view: EditorView; path: string; language: EditorLanguage; kind: ServerLanguage; compartment: Compartment; status: (status: LanguageStatus) => void; active: boolean; attempt: number; baseline: Text; draft: boolean }
/** A binding can be released without closing another tab's service. */
export interface LanguageBinding { close: () => void; restart: () => void }

/** Project-level language services; all IO goes through the research service's runtime adapter. */
export class LanguageServices {
  private api: LanguageServerApi;
  private project: string;
  private open: (path: string) => Promise<void>;
  private notify: (message: string) => void;
  private connections = new Map<ServerLanguage, Promise<Connection>>();
  private bindings = new Set<Binding>();
  private views = new Map<string, EditorView>();
  private drafts = new Map<string, { doc: Text; language: EditorLanguage }>();
  private forgotten = new Set<string>();
  private waiting = new Map<string, Set<(view: EditorView | null) => void>>();
  /** Installed packages' files opened from a definition, by tab. */
  private library = new Map<string, string>();
  private closed = false;

  /** Keep callbacks current in React without replacing server connections or editor state. */
  constructor(api: LanguageServerApi, project: string, open: (path: string) => Promise<void>, notify: (message: string) => void) {
    this.api = api; this.project = project; this.open = open; this.notify = notify;
  }
  /** Navigation callbacks may change when the active file changes. */
  callbacks(open: (path: string) => Promise<void>, notify: (message: string) => void): void { this.open = open; this.notify = notify; }

  /** Attach semantics after the editor exists, without rebuilding the document or its undo history. */
  attach(view: EditorView, path: string, language: EditorLanguage, draft: boolean, status: (status: LanguageStatus | null) => void): LanguageBinding {
    this.closed = false;
    this.forgotten.delete(path);
    this.views.set(path, view);
    for (const ready of this.waiting.get(path) ?? []) ready(view);
    // An installed package's file is only read: it is shown where a definition points, and no server opens it.
    const kind = isLibraryPath(path) ? null : serverLanguage(language);
    if (!kind) {
      status(null);
      return { close: () => { if (this.views.get(path) === view) this.views.delete(path); }, restart: () => {} };
    }
    const binding: Binding = { view, path, language, kind, compartment: new Compartment(), status, active: true, attempt: 0, baseline: view.state.doc, draft };
    view.dispatch({ effects: StateEffect.appendConfig.of(binding.compartment.of([])) });
    this.bindings.add(binding);
    void this.connectBinding(binding);
    return {
      close: () => {
        if (!this.forgotten.has(path) && (binding.draft || !binding.baseline.eq(view.state.doc))) this.drafts.set(path, { doc: view.state.doc, language });
        else this.forget(path);
        binding.active = false; this.bindings.delete(binding); if (this.views.get(path) === view) this.views.delete(path);
      },
      restart: () => { void this.restart(kind); },
    };
  }

  /** Start at most one process per server family, with safe hover rendering and only the editing features we support. */
  private connection(kind: ServerLanguage): Promise<Connection> {
    let pending = this.connections.get(kind);
    if (!pending) {
      pending = (async () => {
        const session = await this.api.startLanguageServer(this.project, kind);
        if (this.closed) { await this.api.stopLanguageServer(this.project, session.id); throw new Error("The workspace closed."); }
        const client = new SourceLanguageClient({
          rootUri: session.rootUri,
          timeout: 12000,
          sanitizeHTML: html => DOMPurify.sanitize(html, { ALLOWED_TAGS: ["p", "br", "pre", "code", "em", "strong", "ul", "ol", "li", "span", "blockquote"], ALLOWED_ATTR: [] }),
          workspace: client => new SourceWorkspace(client, uri => this.display(session, uri)),
          extensions: [serverCompletion(), hoverTooltips(), signatureHelp(), serverDiagnostics(), pullDiagnostics(), keymap.of(jumpToDefinitionKeymap)],
          notificationHandlers: { "window/logMessage": () => true, "window/showMessage": () => true },
        });
        const transport = new LanguageTransport(this.api, this.project, session.id, message => {
          connection.dead = message;
          client.stop(message);
          if (this.connections.get(kind) !== pending) return;
          for (const binding of this.bindings) if (binding.kind === kind) {
            binding.view.dispatch({ effects: binding.compartment.reconfigure([]) });
            binding.status({ state: "unavailable", server: session.server, message });
          }
        });
        const connection: Connection = { client, transport, session };
        for (const [path, draft] of this.drafts) if (serverLanguage(draft.language) === kind) (client.workspace as SourceWorkspace).seed(documentUri(session.rootUri, path), protocolLanguage(draft.language), draft.doc);
        try { client.connect(transport); await client.ready(); }
        catch (error) { transport.close(); client.disconnect(); await this.api.stopLanguageServer(this.project, session.id).catch(() => {}); throw error; }
        return connection;
      })();
      this.connections.set(kind, pending);
    }
    return pending;
  }

  /** A stale async response cannot attach to an editor that has already been closed or switched. */
  private async connectBinding(binding: Binding): Promise<void> {
    const attempt = ++binding.attempt;
    binding.status({ state: "starting" });
    try {
      const connection = await this.connection(binding.kind);
      if (!binding.active || this.closed || binding.attempt !== attempt) return;
      if (connection.dead) throw new Error(connection.dead);
      binding.view.dispatch({ effects: binding.compartment.reconfigure(connection.client.plugin(documentUri(connection.session.rootUri, binding.path), protocolLanguage(binding.language))) });
      binding.status({ state: "ready", server: connection.session.server });
    } catch (error) {
      if (binding.active && !this.closed && binding.attempt === attempt) binding.status({ state: "unavailable", message: languageError(error) });
    }
  }

  /** Restart explicitly after installation, a Python change, or a server failure; live editor state stays in place. */
  private async restart(kind: ServerLanguage): Promise<void> {
    const previous = this.connections.get(kind);
    this.connections.delete(kind);
    for (const binding of this.bindings) if (binding.kind === kind) {
      binding.attempt++;
      binding.status({ state: "starting" });
      binding.view.dispatch({ effects: binding.compartment.reconfigure([]) });
    }
    if (previous) await previous.then(async connection => { connection.client.disconnect(); connection.transport.close(); await this.api.stopLanguageServer(this.project, connection.session.id).catch(() => {}); }).catch(() => {});
    if (!this.closed) for (const binding of this.bindings) if (binding.kind === kind) void this.connectBinding(binding);
  }

  /** The text of an installed package's file a definition opened, while its tab is open. */
  libraryText(path: string): string | undefined { return this.library.get(path); }

  /** A definition in the project opens through the grant-checked file flow; one in an installed package opens read-only,
   * through a runtime read that serves nothing else outside the project. */
  private async display(session: LanguageSession, uri: string): Promise<EditorView | null> {
    let path = documentPath(session.rootUri, uri);
    if (!path) {
      try {
        const opened = await this.api.libraryFile(this.project, session.id, uri);
        path = LIBRARY_PREFIX + opened.path;
        this.library.set(path, opened.content);
      } catch (error) {
        this.notify(error instanceof Error ? error.message : t("This definition is outside the project. Its source cannot be opened here."));
        return null;
      }
    }
    if (this.views.has(path)) return this.views.get(path)!;
    return new Promise(resolve => {
      const listeners = this.waiting.get(path) ?? new Set();
      const finish = (view: EditorView | null) => { clearTimeout(timer); listeners.delete(finish); if (!listeners.size) this.waiting.delete(path); resolve(view); };
      const timer = setTimeout(() => { this.notify(t("The definition file could not be opened.")); finish(null); }, 10000);
      listeners.add(finish); this.waiting.set(path, listeners);
      void this.open(path).catch(error => { this.notify(error instanceof Error ? error.message : String(error)); finish(null); });
    });
  }

  /** Let a server refresh disk-based imports only after a save actually succeeded. */
  saved(path: string, content: string): void {
    this.drafts.delete(path);
    for (const binding of this.bindings) if (binding.path === path) { binding.baseline = Text.of(content.split(/\r\n|[\r\n]/)); binding.draft = false; }
    for (const pending of this.connections.values()) void pending.then(connection => {
      if (connection.dead || this.closed) return;
      connection.client.sync();
      connection.client.notification("textDocument/didSave", { textDocument: { uri: documentUri(connection.session.rootUri, path) } });
      connection.client.notification("workspace/didChangeWatchedFiles", { changes: [{ uri: documentUri(connection.session.rootUri, path), type: 2 }] });
    }).catch(() => {});
  }

  /** A discarded or renamed source buffer must stop influencing imports in other files. */
  forget(path: string): void {
    this.library.delete(path);
    this.forgotten.add(path);
    this.drafts.delete(path);
    for (const pending of this.connections.values()) void pending.then(connection => {
      (connection.client.workspace as SourceWorkspace).forget(documentUri(connection.session.rootUri, path));
    }).catch(() => {});
  }

  /** Close every connection on project change; the runtime also reaps processes if the window disappears. */
  close(): void {
    this.closed = true;
    for (const listeners of this.waiting.values()) for (const finish of [...listeners]) finish(null);
    for (const pending of this.connections.values()) void pending.then(async connection => {
      connection.client.disconnect(); connection.transport.close(); await this.api.stopLanguageServer(this.project, connection.session.id).catch(() => {});
    }).catch(() => {});
    this.connections.clear();
  }
}
