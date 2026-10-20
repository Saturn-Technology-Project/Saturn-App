import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loginCommandFor } from "../src/application/claude-code.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-claude-code-"));
  const store = new FileStore(directory);
  await store.load();
  return { directory, store, ...createApp(store) };
}

test("Claude Code runs with no credential that could outrank the user's own login", async () => {
  const { directory, services } = await setup();
  const saved = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "token-should-not-leak";
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  try {
    const env = services.kernel.claudeCode.environment();
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(directory, "claude"), "a Saturn-only login, apart from other Claude apps");
    assert.equal(Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1], Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1]);
  } finally {
    process.env = saved;
  }
});

test("login status comes from the official claude program, with the command to sign in", async () => {
  const { directory, services } = await setup();
  const status = await services.kernel.claudeCode.status();
  assert.equal(status.loggedIn, false);
  assert.equal(status.error, undefined, "a signed-out answer is not an error");
  assert.ok(status.loginCommand.includes(path.join(directory, "claude")), status.loginCommand);
  assert.match(status.loginCommand, /claude(\.exe)?'? auth login --claudeai$/);
});

test("the sign-in command uses PowerShell on Windows and the POSIX shell elsewhere", () => {
  assert.equal(loginCommandFor("darwin", "/Users/a b/.saturn-app/claude", "/opt/claude"), "CLAUDE_CONFIG_DIR='/Users/a b/.saturn-app/claude' /opt/claude auth login --claudeai");
  assert.equal(
    loginCommandFor("win32", "C:\\Users\\O'Neil\\.saturn-app\\claude", "C:\\Saturn\\claude.exe"),
    "$env:CLAUDE_CONFIG_DIR='C:\\Users\\O''Neil\\.saturn-app\\claude'; & 'C:\\Saturn\\claude.exe' auth login --claudeai",
  );
});

test("a Claude Code model keeps its effort, and a run without a login fails with how to sign in", async () => {
  const { services } = await setup();
  await assert.rejects(() => services.createModel({ provider: "nope", model: "x" }), /Claude Code/);
  const model = await services.createModel({ provider: "claude-code", model: "claude-haiku-4-5", effort: "high" });
  assert.equal(model.effort, "high");
  assert.equal((await services.updateModel(model.id, { effort: "bogus" })).effort, "high", "unknown efforts are ignored");
  assert.equal((await services.updateModel(model.id, { effort: null })).effort, undefined, "null clears it");

  const agent = await services.createAgent({ name: "Coder", modelConnectionId: model.id });
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ignored";
  try {
    const run = await services.startRun(agent.id, "say hi");
    let current: Run = services.kernel.getRun(run.id);
    for (let attempt = 0; attempt < 300 && (current.status === "running" || current.status === "queued"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = services.kernel.getRun(run.id);
    }
    assert.equal(current.status, "failed");
    assert.match(current.error ?? "", /isn't signed in for Saturn/, "even with an API key in the runtime's environment");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
  assert.throws(() => services.kernel.claudeCode.decide("run_x", "act_x", true), /no longer waiting/);
});

test("a Claude Code agent's own Bypass / Default / Review setting decides what asks, unless its group says otherwise", async () => {
  const { approvalMode } = await import("../src/application/claude-code.js");
  assert.equal(approvalMode({ autonomy: "bypass" }), "bypass", "Bypass in the chat never asks");
  assert.equal(approvalMode({ autonomy: "fully_autonomous" }), "bypass");
  assert.equal(approvalMode({ autonomy: "execute_when_allowed" }), "default", "the default asks only for risky actions");
  assert.equal(approvalMode({ autonomy: "review" }), "review");
  assert.equal(approvalMode({ autonomy: "bypass" }, "review"), "review", "a group's setting wins while the agent works there");
});
