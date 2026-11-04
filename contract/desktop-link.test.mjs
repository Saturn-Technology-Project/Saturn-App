// A runtime started by the desktop app holds a pipe from it: closing the pipe is the request to stop, on every system, and a crashed
// app closes it too. The TypeScript runtime watches the app's process id instead, and goes away with Electron.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeKind, startRuntime } from "./runtime.mjs";

const skip = runtimeKind === "ts" && "the TypeScript runtime watches a process id";

async function ended(child, ms) {
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise((resolve) => child.once("close", (code) => resolve(code))),
    new Promise((resolve) => setTimeout(() => resolve("still running"), ms)),
  ]);
}

test("a runtime the app started stops, and exits cleanly, when the app's pipe closes", { skip }, async () => {
  const runtime = await startRuntime({ stdin: "pipe", env: { SATURN_DESKTOP_ATTACHED: "1" } });
  try {
    assert.equal((await fetch(`${runtime.origin}/health`)).ok, true);
    assert.equal(await ended(runtime.child, 300), "still running", "it stays up while the pipe is open");
    runtime.child.stdin.end();
    assert.equal(await ended(runtime.child, 5000), 0);
  } finally {
    await runtime.stop();
  }
});

test("a runtime started by itself is not stopped by having no input", { skip }, async () => {
  const runtime = await startRuntime();
  try {
    assert.equal(await ended(runtime.child, 500), "still running");
    assert.equal((await fetch(`${runtime.origin}/health`)).ok, true);
  } finally {
    await runtime.stop();
  }
});
