// A real stdio process with LSP framing; tests replace installed servers on PATH, never the runtime's protocol code.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

let buffer = Buffer.alloc(0), root, uri, mode;
const documents = new Map();

/** Write a byte-counted frame in pieces, including non-ASCII strings. */
function emit(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  const wire = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  process.stdout.write(wire.subarray(0, 7)); process.stdout.write(wire.subarray(7));
}

/** A tiny deterministic server: protocol behavior is real, semantic answers deliberately stand in for a checker. */
function receive(message) {
  if (message.method === "initialize") {
    root = fileURLToPath(message.params.rootUri); uri = message.params.rootUri;
    mode = existsSync(path.join(root, "lsp-mode")) ? readFileSync(path.join(root, "lsp-mode"), "utf8") : "";
    const child = mode === "child" ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : null;
    writeFileSync(path.join(root, "lsp-process.json"), JSON.stringify({ pid: process.pid, child: child?.pid }));
  }
  if (root) appendFileSync(path.join(root, "lsp-received.jsonl"), `${JSON.stringify(message)}\n`);
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      emit({ id: 900, method: "workspace/configuration", params: { items: [{ section: "python" }, { section: "basedpyright" }] } });
      emit({ id: 901, method: "workspace/applyEdit", params: { edit: { changes: { [`${uri}main.py`]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "server wrote this" }] } } } });
      emit({ id, result: { capabilities: { positionEncoding: "utf-16", textDocumentSync: 2, hoverProvider: true, definitionProvider: true, completionProvider: { triggerCharacters: ["."] }, signatureHelpProvider: { triggerCharacters: ["(", ","] } } } });
      if (mode === "malformed") process.stdout.write("Content-Length: 999999999999\r\n\r\n");
      break;
    case "textDocument/didOpen": documents.set(params.textDocument.uri, params.textDocument.text); break;
    case "textDocument/didChange":
      emit({ id: 902, method: "workspace/diagnostic/refresh", params: {} });
      emit({ method: "textDocument/publishDiagnostics", params: { uri: params.textDocument.uri, version: params.textDocument.version, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "型別錯誤 🪐", source: "fake-pyright" }] } });
      break;
    case "textDocument/completion": emit({ id, result: [{ label: "upper", kind: 2, detail: "(method) upper() -> str", insertText: "upper", documentation: "Returns uppercase text." }] }); break;
    case "textDocument/hover": emit({ id, result: { contents: { kind: "markdown", value: "```python\n(variable) result: int\n```" } } }); break;
    case "textDocument/diagnostic": emit({ id, result: { kind: "full", items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "Pulled type error" }] } }); break;
    case "textDocument/signatureHelp": emit({ id, result: { signatures: [{ label: "train(steps: int) -> float", parameters: [{ label: "steps: int" }] }], activeSignature: 0, activeParameter: 0 } }); break;
    case "textDocument/definition": emit({ id, result: { uri: `${uri}helpers.py`, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } } } }); break;
    case "shutdown": emit({ id, result: null }); break;
    case "exit": process.exit(0); break;
    default: if (id !== undefined && method) emit({ id, result: null });
  }
}

process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const size = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
    if (!Number.isSafeInteger(size)) process.exit(2);
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
    buffer = buffer.subarray(end + 4 + size); receive(message);
  }
});
process.stdin.on("end", () => process.exit(0));
