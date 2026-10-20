// The Saturn chat panel's page is built in extension.js as one template string, so a backslash that should reach
// the page's script (a regex, an escaped quote, "\n") is easily eaten by the template and the whole panel's script
// stops parsing. This renders the page with a stand-in `vscode` and parses every inline script (no VS Code needed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const extension = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "saturn", "extension.js");

/** Anything: callable, constructible, every property another anything. */
const anything = () => new Proxy(function () {}, {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : anything()),
  apply: () => anything(),
  construct: () => anything(),
});

test("the chat panel's page renders and its script parses", () => {
  const source = readFileSync(extension, "utf8");
  const body = /\n\thtml\(webview\) \{([\s\S]*?)\n\t\}\n\}/.exec(source);
  assert.ok(body, "AgentView.html(webview) is where the page is built");
  const render = new Function("webview", "vscode", "require", "nodePath", `return (function () {${body[1]}}).call({ context: { extensionUri: {} } });`);
  const html = render({ cspSource: "vscode-resource:", asWebviewUri: () => "icon.png" }, anything(), require, path);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0, "the page has its script");
  for (const [index, script] of scripts.entries()) {
    try {
      new vm.Script(script, { filename: `chat-panel-script-${index}.js` });
    } catch (error) {
      const line = Number((/chat-panel-script-\d+\.js:(\d+)/.exec(String(error.stack)) || [])[1]);
      assert.fail(`The chat panel's script does not parse: ${error.message}\n${line ? script.split("\n").slice(line - 3, line + 2).join("\n") : ""}`);
    }
  }
});
