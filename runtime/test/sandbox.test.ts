import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Workspace } from "../src/domain/skills/workspace.js";
import { CodeSkill } from "../src/infrastructure/skills/code-skill.js";
import { sandboxHint, sandboxSupport, seatbeltProfile, wrapCommand, writableFolders } from "../src/infrastructure/sandbox.js";

type Result = { stdout: string; stderr: string; exitCode: number; sandboxed: boolean; sandbox?: string };

test("the sandbox plan: off runs the command as is, Windows has none, seatbelt limits writes and the network", () => {
  const invocation = { file: "/bin/sh", args: ["-c", "true"] };
  assert.deepEqual(wrapCommand(invocation, { mode: "off", network: true }, "/work"), { ...invocation, sandboxed: false });
  const windows = wrapCommand(invocation, { mode: "workspace-write", network: true }, "C:\\work", [], "win32", {});
  assert.equal(windows.sandboxed, false);
  assert.match(windows.reason ?? "", /Windows/);
  assert.equal(sandboxSupport("win32").available, false);

  const profile = seatbeltProfile("workspace-write", ["/work", "/tmp"], false);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/work"\) \(subpath "\/tmp"\)\)/);
  assert.match(profile, /\(deny network\*\)/);
  const readOnly = seatbeltProfile("read-only", ["/work", "/tmp"], true);
  assert.match(readOnly, /\(allow file-write\* \(subpath "\/tmp"\)\)/, "read-only still allows temp files");
  assert.match(readOnly, /\(deny file-write\* \(subpath "\/work"\)\)$/m, "read-only denies the workspace last, so it wins");
  assert.ok(!seatbeltProfile("workspace-write", ["/work"], true).includes("deny network"));
  assert.ok(writableFolders("/work", ["/extra"], { HOME: "/Users/x", PATH: "" }, "darwin").includes("/Users/x/.npm"));
  assert.match(sandboxHint("mkdir: /etc/x: Operation not permitted", { mode: "workspace-write", network: true }) ?? "", /sandbox: "off"/);
  assert.equal(sandboxHint("some other error", { mode: "workspace-write", network: true }), undefined);
});

test("on macOS a sandboxed command writes inside the workspace only; read-only writes nowhere; off writes anywhere", { skip: process.platform !== "darwin" && "macOS only" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "saturn-sandbox-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "saturn-sandbox-outside-"));
  // Temp folders are writable under the sandbox, so the "outside" folder is put under the home folder instead.
  const elsewhere = path.join(os.homedir(), `.saturn-sandbox-test-${process.pid}`);
  const skill = new CodeSkill(new Workspace(root));
  const run = (command: string, mode: "workspace-write" | "read-only" | "off", args: Record<string, unknown> = {}) =>
    skill.run({ command, ...args }, undefined, { sandbox: { mode, network: true } }) as Promise<Result>;

  const inside = await run("echo hello > note.txt && cat note.txt", "workspace-write");
  assert.equal(inside.exitCode, 0, inside.stderr);
  assert.equal(inside.sandboxed, true);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "hello\n");

  const blocked = await run(`mkdir ${elsewhere}`, "workspace-write");
  assert.notEqual(blocked.exitCode, 0, "a write under the home folder is refused");
  assert.match(blocked.stderr, /sandbox: "off"/, "the model is told how to ask");
  await assert.rejects(() => stat(elsewhere));

  const readOnly = await run("echo x > other.txt", "read-only");
  assert.notEqual(readOnly.exitCode, 0);
  await assert.rejects(() => stat(path.join(root, "other.txt")));
  const readOnlyRead = await run("cat note.txt", "read-only");
  assert.equal(readOnlyRead.stdout.trim(), "hello");

  // The call's own sandbox: "off" (approved by the time the skill runs) lifts the limit.
  const off = await run(`mkdir ${path.join(outside, "made")} && rmdir ${path.join(outside, "made")}`, "workspace-write", { sandbox: "off" });
  assert.equal(off.exitCode, 0, off.stderr);
  assert.equal(off.sandboxed, false);
});

test("on macOS the sandbox can keep commands off the network", { skip: process.platform !== "darwin" && "macOS only" }, async () => {
  const server = createServer((_req, res) => res.end("reached"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const root = await mkdtemp(path.join(os.tmpdir(), "saturn-sandbox-net-"));
  const skill = new CodeSkill(new Workspace(root));
  try {
    const open = (await skill.run({ command: `curl -s http://127.0.0.1:${address.port}/` }, undefined, { sandbox: { mode: "workspace-write", network: true } })) as Result;
    assert.equal(open.stdout, "reached");
    const closed = (await skill.run({ command: `curl -s http://127.0.0.1:${address.port}/` }, undefined, { sandbox: { mode: "workspace-write", network: false } })) as Result;
    assert.notEqual(closed.exitCode, 0);
    assert.match(closed.stderr, /network/i);
  } finally {
    server.close();
  }
});
