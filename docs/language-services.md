# Source-file language services

The Workspace uses CodeMirror's official LSP client. A language server supplies semantic completion, inferred-type
hover, function signatures, diagnostics and F12 definition navigation. No model or API credential is involved.

## Setup

- **Python:** choose the project's interpreter under Environment. Install its **Python language server** kit in the
  managed `.venv`, or install `basedpyright` in an existing environment. Saturn looks beside the selected interpreter,
  in the managed environment and on PATH; Pyright on PATH or beside the interpreter is also supported. The server gets
  the selected interpreter as `python.pythonPath`, so imports use that environment. The default checking level is
  `basic`; a project's `pyrightconfig.json` / `pyproject.toml` can specify its checking rules.
- **JavaScript/TypeScript, JSX/TSX:** TypeScript 7 includes its own LSP. Saturn prefers the project's
  `node_modules/.bin/tsc`, then TypeScript 7 on PATH, and runs `tsc --lsp --stdio`. A compiler is recognized through its
  package name and major version. TypeScript 6 users can install `typescript-language-server` and `typescript@6` on
  PATH; the wrapper uses the project's classic `tsserver.js` or its installed fallback. TypeScript 7 no longer supplies
  that classic server and must use the native service.
- **Rust:** install `rust-analyzer` on PATH, for example with `rustup component add rust-analyzer`. Automatic cargo
  checks, build scripts and procedural macros are disabled by this client's settings. Parsing, inference and
  navigation remain available without starting a build on every save.

Saturn never installs a language server merely because a file opened. A missing server leaves ordinary syntax/document completion available, and the status
bar explains why semantic services are unavailable. The Python setup control opens Environment. Restart the service
from the status bar after installation or changing interpreters; changing Python stops old processes first.

F12 opens definitions through the same file-reading route as the project tree. Definitions outside the project are
reported instead of opening arbitrary local files. Types from external packages and their stubs can still be shown in
hover/completion. These services currently apply to source files, not notebook cells, and are unavailable on Windows.
They infer programming-language types, not runtime tensor shapes, values or numerical correctness.

## State and diagnostics

One Workspace owns one client/process per server family. File changes are sent before semantic requests. Version
numbers increase as buffers synchronize. Switching tabs retains unsaved imported buffers in the server; saving,
discarding, renaming and restarting update those overlays. Clean inactive files are closed, so imports can see disk
changes instead of stale editor text. Restarting preserves unsaved overlays as well as the editor's undo state.

Older servers publish diagnostics. TypeScript 7 and other newer servers can require LSP 3.17 `textDocument/diagnostic`
requests; the client debounces those, cancels superseded requests and checks both the document identity and version
before accepting a response. Server requests to refresh diagnostics trigger a fresh pull. Hover documentation is
sanitized with DOMPurify; scripts, event attributes, links and remote images are not rendered.

## Runtime transport and boundaries

All four routes require the normal runtime token and current project folder access:

- `POST /projects/:id/research/lsp/start` with `language: python | typescript | rust` returns a session ID, root file
  URI, server name and the selected Python. Programs and arguments are selected by Rust, not supplied by the caller.
- `POST /projects/:id/research/lsp/:session/messages` with `messages: [JSON-RPC message, ...]` writes stdio frames in
  order. Document and changed-file URIs go through the ordinary source path checks, including bookkeeping folders.
  Initialization always uses the authorized project root and UTF-16 positions, with runtime-selected initialization
  options instead of caller-supplied plugins. The TypeScript wrapper's automatic typing acquisition is disabled.
- `GET /projects/:id/research/lsp/:session/events?after=<sequence>` carries `lsp` SSE events with `{seq, message}`.
  The initial `{connected:true}` event has no sequence. Output is replayed from a bounded buffer; a missed sequence or
  ended process closes the connection explicitly rather than leaving requests operating on stale contents.
- `DELETE /projects/:id/research/lsp/:session` stops and reaps the process group. A session cannot be used from another
  project. Revocation, project removal, folder changes, Python changes and runtime shutdown stop its servers too.

Messages are limited to 8 MiB, headers to 8 KiB, replay to 16 MiB and sessions to six per project. Lost clients expire
after 90 seconds without a listener or client activity. Stderr is drained without storing or returning its contents.
Runtime-only `SATURN_*` variables are removed from child environments. No assistant research tool exposes this bridge.

Language servers are local development processes running as the user, outside the experiment sandbox. Project URI
checks constrain the exposed client operations, not the server's OS-level filesystem access. Saturn forwards document
synchronization and semantic queries, answers configuration/progress requests, and refuses `workspace/executeCommand`,
formatting, symbol rename and `workspace/applyEdit`. Explicitly accepted completion edits affect the current editor
buffer; protocol traffic never saves a source file or creates a research run.

## Verification

`contract/language-servers.test.mjs` uses real child processes implementing a deterministic stdio LSP, covering framing,
UTF-8 payloads, project Python settings, semantic queries, push/pull diagnostics, denied edits, project boundaries,
TypeScript 7 detection, access/environment/folder changes, malformed output and descendant cleanup. Frontend tests cover
ordered transport, gaps/duplicates, failure, unsaved imports, restart overlays, URI boundaries and stale diagnostic
responses. These tests use temporary projects and no model credentials.

Client shutdown is also tested before initialization and during a semantic request: the editor receives an immediate
failure or empty cancelled result, and queued notifications cannot outlive a failed handshake.

Actual Basedpyright, TypeScript 7 and rust-analyzer are also checked with small isolated projects during development.
A temporary venv containing a stub-only package verifies that Python imports use the selected environment. Native Tauri and
Windows verification are separate from browser verification; a successful browser test does not establish either.
