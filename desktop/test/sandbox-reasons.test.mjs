// The runtime's reasons the sandbox is off are shown in the interface's language, and each one the interface knows is
// one the runtime really gives, word for word.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sandboxReason } from "../src/domain/sandbox.ts";

const tools = new URL("../../crates/workbench-tools/src/", import.meta.url);
const core = new URL("../../crates/workbench-core/src/", import.meta.url);
const runtime = ["sandbox.rs", "appcontainer.rs"].map((name) => readFileSync(new URL(name, tools), "utf8")).join("\n") + readFileSync(new URL("admin.rs", core), "utf8");
const known = [...readFileSync(new URL("../src/domain/sandbox.ts", import.meta.url), "utf8").matchAll(/case "(.+)":/g)].map((match) => match[1]);

test("every reason the interface translates is given by the runtime word for word", () => {
  assert.ok(known.length >= 7);
  for (const reason of known) assert.ok(runtime.includes(reason), `the runtime no longer says: ${reason}`);
});

test("a known reason is translated and any other is shown as the runtime said it", () => {
  const marked = (text) => `[${text}]`;
  assert.equal(sandboxReason("the administrator prompt was declined", marked), "[the administrator prompt was declined]");
  assert.equal(sandboxReason("PowerShell could not be started: denied", marked), "PowerShell could not be started: denied");
  assert.equal(sandboxReason(null, marked), "");
});
