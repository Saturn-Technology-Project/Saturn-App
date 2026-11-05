// Whole turns of Claude Code and Codex. The arguments and messages checked here are what the official SDKs send, recorded from them
// through the stand-ins in programs.mjs, which is the protocol.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { runToEnd, startWithPrograms, untilCard, untilFinished } from "./programs.mjs";

/** The model and agent of a test, on either program. */
async function coder(saturn, provider, { model = "the-model", effort, ...agent } = {}) {
  const connection = await saturn.api("POST", "/connections/models", { provider, model, ...(effort ? { effort } : {}) });
  return await saturn.api("POST", "/agents", { name: "Coder", modelConnectionId: connection.id, ...agent });
}

/** A project folder and a chat in it. */
async function projectChat(saturn, agent) {
  const folder = path.join(saturn.folder, "project");
  await mkdir(folder, { recursive: true });
  const project = await saturn.api("POST", "/projects", { path: folder, grant: true });
  const thread = await saturn.api("POST", `/agents/${agent.id}/threads`, { title: "Work", projectId: project.id });
  return { folder: await realpath(folder), project, thread };
}

const result = (text, session = "session-1", usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }) => ({
  send: { type: "result", subtype: "success", is_error: false, result: text, session_id: session, usage },
});
const assistant = (...content) => ({ send: { type: "assistant", session_id: "session-1", message: { role: "assistant", content } } });
const toolResult = (id, content, isError = false) => ({ send: { type: "user", session_id: "session-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } } });

const started = async (saturn) => (await saturn.journal()).filter((entry) => entry.started && entry.args[0] !== "--version" && entry.args[0] !== "auth");
const received = async (saturn) => (await saturn.journal()).filter((entry) => entry.received).map((entry) => entry.received);

test("a Claude Code turn starts the program as the SDK does, opens with what Saturn knows, and shows what happened", async () => {
  const saturn = await startWithPrograms({ env: { ANTHROPIC_API_KEY: "the-users-own-key", ELECTRON_RUN_AS_NODE: "1" } });
  try {
    const agent = await coder(saturn, "claude-code", { effort: "high", instructions: "Be brief.", autonomy: "bypass", mcpConnectionIds: ["general-skills"] });
    await saturn.scenario({
      steps: [
        { send: { type: "system", subtype: "init", session_id: "session-1" } },
        assistant({ type: "thinking", thinking: "Look at the files first." }, { type: "text", text: "Reading." }, { type: "tool_use", id: "tu_read", name: "Read", input: { file_path: "a.ts" } }),
        toolResult("tu_read", [{ type: "text", text: "contents" }]),
        assistant({ type: "tool_use", id: "tu_grep", name: "Grep", input: { pattern: "x" } }),
        toolResult("tu_grep", "no such thing", true),
        assistant({ type: "text", text: "Done reading." }),
        result("The final answer."),
      ],
    });
    const run = await runToEnd(saturn, agent.id, { input: "read a.ts" });
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.output, "The final answer.");
    assert.deepEqual(run.thoughts.map((item) => [item.text, item.seconds, item.at]), [["Look at the files first.", 0, 0]]);
    assert.deepEqual(run.actions, [
      { id: "tu_read", toolId: "Read", arguments: { file_path: "a.ts" }, status: "completed", result: { output: "contents" } },
      { id: "tu_grep", toolId: "Grep", arguments: { pattern: "x" }, status: "failed", result: { output: "no such thing" }, reason: "no such thing" },
    ]);

    const [program] = await started(saturn);
    assert.deepEqual(program.args, ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--effort=high", "--model=the-model", "--permission-prompt-tool=stdio", "--disallowedTools=WebSearch,WebFetch", "--setting-sources=", "--permission-mode=default"]);
    assert.equal(program.env.CLAUDE_CONFIG_DIR, path.join(saturn.dataDir, "claude"));
    assert.equal(program.env.ANTHROPIC_API_KEY, "the-users-own-key");
    assert.equal(program.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(program.cwd, await realpath(path.join(saturn.dataDir, "workspace")));

    const [initialize, user] = await received(saturn);
    assert.equal(initialize.type, "control_request");
    assert.deepEqual([initialize.request.subtype, initialize.request.appendSystemPrompt], ["initialize", "Be brief."]);
    assert.equal(initialize.request.sdkMcpServers, undefined, "no skills attached, so no skills server");
    assert.deepEqual(user, { type: "user", session_id: "", message: { role: "user", content: [{ type: "text", text: "read a.ts" }] }, parent_tool_use_id: null });
    assert.ok((await saturn.journal()).some((entry) => entry.stdin === "closed"), "its input closes once the turn has a result, so the program ends");

    const usage = (await saturn.api("GET", "/usage")).find((item) => item.runId === run.id);
    assert.deepEqual([usage.inputTokens, usage.outputTokens, usage.pricing, usage.costUsd, usage.provider, usage.purpose], [15, 5, "Claude plan", null, "claude-code", "run"]);
  } finally {
    await saturn.stop();
  }
});

test("the next turn of a Claude Code chat resumes its session", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { autonomy: "bypass" });
    await saturn.scenario({ steps: [{ send: { type: "system", subtype: "init", session_id: "session-A" } }, result("one", "session-A")] });
    const first = await runToEnd(saturn, agent.id, { input: "first" });
    assert.equal(first.status, "completed", first.error);
    await saturn.forget();
    const second = await runToEnd(saturn, agent.id, { input: "second", threadId: first.threadId });
    assert.equal(second.status, "completed", second.error);
    const [program] = await started(saturn);
    assert.ok(program.args.includes("--resume=session-A"), program.args.join(" "));
  } finally {
    await saturn.stop();
  }
});

test("Saturn's rules, memory, mode and an image reach Claude Code; Plan is the program's own plan mode", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { instructions: "Be brief." });
    const { folder, thread } = await projectChat(saturn, agent);
    await writeFile(path.join(folder, "CLAUDE.md"), "Use small commits.\n");
    await saturn.api("PUT", "/memory/global", { content: "- Prefers tabs over spaces." });
    await saturn.scenario({ steps: [result("planned")] });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==";
    const run = await runToEnd(saturn, agent.id, { input: "make a plan", threadId: thread.id, mode: "plan", images: [`data:image/png;base64,${png}`] });
    assert.equal(run.status, "completed", run.error);
    const [program] = await started(saturn);
    assert.ok(program.args.includes("--permission-mode=plan"));
    assert.equal(program.cwd, folder);
    const [initialize, user] = await received(saturn);
    assert.match(initialize.request.appendSystemPrompt, /Use small commits\./);
    assert.match(initialize.request.appendSystemPrompt, /Prefers tabs over spaces/);
    assert.match(initialize.request.appendSystemPrompt, /Be brief\.\n\n/);
    assert.deepEqual(user.message.content, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      { type: "text", text: "make a plan" },
    ]);
  } finally {
    await saturn.stop();
  }
});

test("Review asks for everything that is not read-only, and the program gets the user's answer", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { autonomy: "review" });
    await saturn.scenario({
      steps: [
        { permission: { tool: "Read", input: { file_path: "a.ts" }, id: "tu_read" } },
        { permission: { tool: "Bash", input: { command: "ls" }, id: "tu_yes" } },
        { permission: { tool: "Bash", input: { command: "rm -rf x" }, id: "tu_no" } },
        result("answered"),
      ],
    });
    const begun = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "go" });
    const first = await untilCard(saturn, begun.id);
    assert.deepEqual([first.action.id, first.action.toolId, first.action.reason], ["tu_yes", "Bash", "Bash needs your approval"]);
    assert.deepEqual(await saturn.api("POST", `/runs/${begun.id}/actions/tu_yes/decision`, { allow: true }), { ok: true });
    const second = await saturn.until("the next card", () => saturn.api("GET", `/runs/${begun.id}`), (run) => run.actions.some((item) => item.id === "tu_no" && item.status === "waiting_approval"));
    assert.deepEqual(second.actions.map((item) => [item.id, item.status]), [["tu_yes", "completed"], ["tu_no", "waiting_approval"]]);
    assert.equal((await saturn.call("POST", `/runs/${begun.id}/actions/tu_yes/decision`, { allow: true })).status, 409);
    await saturn.api("POST", `/runs/${begun.id}/actions/tu_no/decision`, { allow: false });
    const done = await untilFinished(saturn, begun.id);
    assert.equal(done.status, "completed", done.error);
    assert.deepEqual(done.actions.map((item) => [item.id, item.status, item.reason]), [["tu_yes", "completed", undefined], ["tu_no", "denied", "Denied by the user"]]);

    const answers = (await saturn.journal()).filter((entry) => entry.permission);
    assert.deepEqual(answers.map((entry) => [entry.permission, entry.response]), [
      ["tu_read", { behavior: "allow", updatedInput: { file_path: "a.ts" }, toolUseID: "tu_read" }],
      ["tu_yes", { behavior: "allow", updatedInput: { command: "ls" }, toolUseID: "tu_yes" }],
      ["tu_no", { behavior: "deny", message: "The user denied this action.", toolUseID: "tu_no" }],
    ]);
  } finally {
    await saturn.stop();
  }
});

test("The default asks only for risky actions, and Bypass never asks", async () => {
  const saturn = await startWithPrograms();
  try {
    const usual = await coder(saturn, "claude-code", { autonomy: "execute_when_allowed" });
    const { thread } = await projectChat(saturn, usual);
    const steps = [
      { permission: { tool: "Bash", input: { command: "ls" }, id: "tu_safe" } },
      { permission: { tool: "Edit", input: { file_path: "inside.txt" }, id: "tu_inside" } },
      { permission: { tool: "Bash", input: { command: "rm -rf /" }, id: "tu_risky" } },
      { permission: { tool: "Write", input: { file_path: "/somewhere/else.txt" }, id: "tu_outside" } },
      result("done"),
    ];
    await saturn.scenario({ steps });
    const begun = await saturn.api("POST", `/agents/${usual.id}/runs`, { input: "go", threadId: thread.id });
    const risky = await untilCard(saturn, begun.id);
    assert.equal(risky.action.id, "tu_risky");
    await saturn.api("POST", `/runs/${begun.id}/actions/tu_risky/decision`, { allow: true });
    const outside = await saturn.until("the next card", () => saturn.api("GET", `/runs/${begun.id}`), (run) => run.actions.some((item) => item.id === "tu_outside" && item.status === "waiting_approval"));
    assert.equal(outside.status, "waiting_approval");
    await saturn.api("POST", `/runs/${begun.id}/actions/tu_outside/decision`, { allow: false });
    assert.equal((await untilFinished(saturn, begun.id)).status, "completed");

    await saturn.forget();
    const free = await coder(saturn, "claude-code", { autonomy: "bypass" });
    await saturn.scenario({ steps: [{ permission: { tool: "Bash", input: { command: "rm -rf /" }, id: "tu_any" } }, result("done")] });
    const run = await runToEnd(saturn, free.id, { input: "go" });
    assert.deepEqual(run.actions.map((item) => [item.id, item.status]), [["tu_any", "completed"]]);
  } finally {
    await saturn.stop();
  }
});

test("An Ask turn refuses anything that changes things, and still runs a read-only skill", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { autonomy: "bypass", mcpConnectionIds: ["automations"] });
    await saturn.scenario({
      steps: [
        { permission: { tool: "Read", input: {}, id: "tu_read" } },
        { permission: { tool: "mcp__saturn__automation_list", input: {}, id: "tu_list" } },
        { permission: { tool: "mcp__saturn__automation_delete", input: { id: "x" }, id: "tu_delete" } },
        { permission: { tool: "Bash", input: { command: "ls" }, id: "tu_bash" } },
        result("answered"),
      ],
    });
    const run = await runToEnd(saturn, agent.id, { input: "what is here?", mode: "ask" });
    assert.equal(run.status, "completed", run.error);
    const answers = (await saturn.journal()).filter((entry) => entry.permission).map((entry) => [entry.permission, entry.response.behavior]);
    assert.deepEqual(answers, [["tu_read", "allow"], ["tu_list", "allow"], ["tu_delete", "deny"], ["tu_bash", "deny"]]);
    assert.deepEqual(run.actions.map((item) => [item.id, item.toolId, item.status]), [["tu_delete", "automation_delete", "denied"], ["tu_bash", "Bash", "denied"]]);
    assert.match(run.actions[1].reason, /read/i);
  } finally {
    await saturn.stop();
  }
});

test("An edit in a project keeps its original, so the chat can show the change and revert it", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { autonomy: "bypass" });
    const { folder, thread } = await projectChat(saturn, agent);
    const file = path.join(folder, "note.txt");
    await writeFile(file, "before\n");
    await saturn.scenario({
      steps: [
        { permission: { tool: "Edit", input: { file_path: "note.txt" }, id: "tu_edit", write: { path: file, content: "after\n" } } },
        assistant({ type: "tool_use", id: "tu_edit", name: "Edit", input: { file_path: "note.txt" } }),
        toolResult("tu_edit", "edited"),
        result("changed"),
      ],
    });
    const run = await runToEnd(saturn, agent.id, { input: "edit", threadId: thread.id });
    assert.equal(run.status, "completed", run.error);
    const changes = await saturn.api("GET", `/runs/${run.id}/changes`);
    assert.deepEqual(changes.files?.map((item) => item.path) ?? changes.map?.((item) => item.path), ["note.txt"]);
    await saturn.api("POST", `/runs/${run.id}/changes/revert`, {});
    assert.equal(await readFile(file, "utf8"), "before\n");
  } finally {
    await saturn.stop();
  }
});

test("Saturn's skills reach Claude Code as a server in its own process, and their calls run through Saturn", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { autonomy: "bypass", mcpConnectionIds: ["automations"] });
    await saturn.scenario({
      steps: [
        { mcp: { method: "initialize", id: 1, params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stand-in", version: "1" } } } },
        { mcp: { method: "notifications/initialized", notification: true } },
        { mcp: { method: "tools/list", id: 2 } },
        { mcp: { method: "tools/call", id: 3, params: { name: "automation_list", arguments: {} } } },
        { mcp: { method: "tools/call", id: 4, params: { name: "no_such_tool", arguments: {} } } },
        { mcp: { method: "tools/call", id: 5, server: "other", params: { name: "automation_list", arguments: {} } } },
        result("used a skill"),
      ],
    });
    const run = await runToEnd(saturn, agent.id, { input: "list automations" });
    assert.equal(run.status, "completed", run.error);

    const [initialize] = await received(saturn);
    assert.deepEqual(initialize.request.sdkMcpServers, ["saturn"]);
    const manifest = initialize.request.sdkMcpServerManifests.saturn;
    assert.deepEqual(manifest.initializeResult.serverInfo, { name: "saturn", version: "1.0.0" });
    assert.ok(manifest.toolsListResult.tools.some((tool) => tool.name === "automation_list" && tool.inputSchema.type === "object"));

    const answers = Object.fromEntries((await saturn.journal()).filter((entry) => entry.mcp).map((entry, index) => [`${index}:${entry.mcp}`, entry.response]));
    assert.deepEqual(answers["0:initialize"].mcp_response.result.serverInfo, { name: "saturn", version: "1.0.0" });
    assert.deepEqual(answers["0:initialize"].mcp_response.result.capabilities, { tools: {} });
    assert.equal(answers["0:initialize"].mcp_response.result.protocolVersion, "2025-06-18", "the version the program asked for");
    assert.deepEqual(answers["1:notifications/initialized"].mcp_response, { jsonrpc: "2.0", result: {}, id: 0 });
    const listed = answers["2:tools/list"].mcp_response.result.tools;
    assert.deepEqual(listed.map((tool) => tool.name).sort(), manifest.toolsListResult.tools.map((tool) => tool.name).sort());
    const called = answers["3:tools/call"].mcp_response.result;
    assert.equal(called.isError, undefined);
    assert.deepEqual(JSON.parse(called.content[0].text), { total: 0, filter: "all", automations: [] });
    assert.deepEqual(answers["4:tools/call"].mcp_response.result, { content: [{ type: "text", text: "Unknown tool: no_such_tool" }], isError: true });
    assert.ok(answers["5:tools/call"].error, "only the server Saturn gave it");
  } finally {
    await saturn.stop();
  }
});

test("A turn that fails for want of a login says how to sign in; any other failure says what happened", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { autonomy: "bypass" });
    await saturn.scenario({ steps: [{ send: { type: "result", subtype: "error_during_execution", is_error: true, result: "Invalid API key · please run /login", errors: [], session_id: "s" } }] });
    assert.match((await runToEnd(saturn, agent.id, { input: "hi" })).error, /Claude Code isn't signed in for Saturn yet\. In Settings → General → Claude Code/);

    await saturn.scenario({ steps: [{ send: { type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many turns", "and more"], session_id: "s" } }] });
    const many = await runToEnd(saturn, agent.id, { input: "hi" });
    assert.deepEqual([many.status, many.error], ["failed", "too many turns; and more"]);

    await saturn.scenario({ steps: [{ exit: 3, stderr: "the program broke\n" }] });
    const broke = await runToEnd(saturn, agent.id, { input: "hi" });
    assert.equal(broke.status, "failed");
    assert.match(broke.error, /exited with code 3/);
  } finally {
    await saturn.stop();
  }
});

test("Stopping a Claude Code turn ends the program and leaves the run cancelled; an approval that was waiting goes with it", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { autonomy: "review" });
    await saturn.scenario({ steps: [{ permission: { tool: "Bash", input: { command: "ls" }, id: "tu_wait" } }, { hang: true }] });
    const begun = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "go" });
    await untilCard(saturn, begun.id);
    await saturn.api("POST", `/runs/${begun.id}/stop`, {});
    assert.equal((await saturn.api("GET", `/runs/${begun.id}`)).status, "cancelled");
    await saturn.until("the program to end", () => saturn.journal(), (entries) => entries.some((entry) => entry.signal === "SIGTERM" || entry.stdin === "closed"));
    await saturn.call("POST", `/runs/${begun.id}/actions/tu_wait/decision`, { allow: true });
    assert.equal((await saturn.api("GET", `/runs/${begun.id}`)).status, "cancelled", "a late answer changes nothing");
  } finally {
    await saturn.stop();
  }
});

test("A Codex turn starts the program as the SDK does and shows its reply, reasoning, commands and edits", async () => {
  const saturn = await startWithPrograms({ env: { OPENAI_API_KEY: "stray" } });
  try {
    await saturn.scenario({
      steps: [
        { send: { type: "thread.started", thread_id: "thread-1" } },
        { send: { type: "turn.started" } },
        { send: { type: "item.completed", item: { id: "r1", type: "reasoning", text: "Look at the files first." } } },
        { send: { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" } } },
        { send: { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "a.ts\n", exit_code: 0, status: "completed" } } },
        { send: { type: "item.completed", item: { id: "c2", type: "command_execution", command: "false", aggregated_output: "nope", exit_code: 1, status: "failed" } } },
        { send: { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "completed" } } },
        { send: { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Updated a.ts." } } },
        { send: { type: "item.completed", item: { id: "m2", type: "agent_message", text: "All done." } } },
        { send: { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30 } } },
      ],
    });
    const agent = await coder(saturn, "codex", { model: "gpt-x", effort: "high", instructions: "Be brief.", mcpConnectionIds: ["general-skills"] });
    const run = await runToEnd(saturn, agent.id, { input: "update a.ts" });
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.output, "Updated a.ts.\n\nAll done.");
    assert.deepEqual(run.thoughts.map((item) => item.text), ["Look at the files first."]);
    assert.deepEqual(run.actions, [
      { id: "c1", toolId: "Bash", arguments: { command: "ls" }, status: "completed", result: { output: "a.ts\n", exitCode: 0 } },
      { id: "c2", toolId: "Bash", arguments: { command: "false" }, status: "failed", result: { output: "nope", exitCode: 1 }, reason: "nope" },
      { id: "f1", toolId: "Edit", arguments: { changes: [{ path: "a.ts", kind: "update" }] }, status: "completed", result: { output: "update a.ts" } },
    ]);
    const usage = (await saturn.api("GET", "/usage")).find((item) => item.runId === run.id);
    assert.deepEqual([usage.inputTokens, usage.outputTokens, usage.pricing, usage.costUsd], [120, 30, "ChatGPT plan", null]);

    const [program] = await started(saturn);
    const workspace = await realpath(path.join(saturn.dataDir, "workspace"));
    assert.deepEqual(program.args, ["exec", "--experimental-json", "--model", "gpt-x", "--sandbox", "workspace-write", "--cd", workspace, "--skip-git-repo-check", "--config", 'model_reasoning_effort="high"', "--config", "sandbox_workspace_write.network_access=false", "--config", 'web_search="disabled"', "--config", 'approval_policy="never"']);
    assert.deepEqual(program.env, { CODEX_HOME: path.join(saturn.dataDir, "codex") }, "no API key reaches Codex");
    const prompt = (await saturn.journal()).find((entry) => entry.prompt !== undefined).prompt;
    assert.equal(prompt, "<instructions>\nBe brief.\n</instructions>\n\nupdate a.ts");
  } finally {
    await saturn.stop();
  }
});

test("A Codex thread is resumed, a resumed one is not told again what it knows, and each message carries its knowledge", async () => {
  const saturn = await startWithPrograms();
  const queries = [];
  const rag = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      queries.push(JSON.parse(raw).query);
      response.end("The deploy script is scripts/ship.sh.");
    });
  });
  await new Promise((resolve) => rag.listen(0, "127.0.0.1", resolve));
  try {
    const source = await saturn.api("POST", "/connections/rag", { name: "Docs", url: `http://127.0.0.1:${rag.address().port}/` });
    await saturn.api("PUT", "/memory/global", { content: "- Prefers tabs over spaces." });
    const agent = await coder(saturn, "codex", { model: "default", instructions: "Be brief.", ragConnectionIds: [source.id] });
    await saturn.scenario({
      steps: [
        { send: { type: "thread.started", thread_id: "thread-A" } },
        { send: { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } } },
        { send: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
    });
    const first = await runToEnd(saturn, agent.id, { input: "how do I deploy?" });
    assert.equal(first.status, "completed", first.error);
    const [opening] = await started(saturn);
    assert.equal(opening.args.includes("--model"), false, "the default model is Codex's own choice");
    const second = await runToEnd(saturn, agent.id, { input: "and roll back?", threadId: first.threadId });
    assert.equal(second.status, "completed", second.error);
    const programs = await started(saturn);
    assert.ok(programs[1].args.join(" ").includes("resume thread-A"), programs[1].args.join(" "));
    const prompts = (await saturn.journal()).filter((entry) => entry.prompt !== undefined).map((entry) => entry.prompt);
    assert.match(prompts[0], /<instructions>\nBe brief\.\n<\/instructions>/);
    assert.match(prompts[0], /<knowledge>[\s\S]*scripts\/ship\.sh[\s\S]*<\/knowledge>\n\nhow do I deploy\?$/);
    assert.match(prompts[0], /<memory>[\s\S]*Prefers tabs over spaces[\s\S]*<\/memory>/);
    assert.doesNotMatch(prompts[1], /<instructions>|<memory>/);
    assert.match(prompts[1], /<knowledge>[\s\S]*<\/knowledge>\n\nand roll back\?$/);
    assert.deepEqual(queries, ["how do I deploy?", "and roll back?"]);
  } finally {
    rag.close();
    await saturn.stop();
  }
});

test("A resumed Codex thread is told instructions that changed since it last heard them, once", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "codex", { model: "default", instructions: "Be brief." });
    await saturn.scenario({
      steps: [
        { send: { type: "thread.started", thread_id: "thread-A" } },
        { send: { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } } },
        { send: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
    });
    const prompts = async () => (await saturn.journal()).filter((entry) => entry.prompt !== undefined).map((entry) => entry.prompt);
    const first = await runToEnd(saturn, agent.id, { input: "one" });
    await runToEnd(saturn, agent.id, { input: "two", threadId: first.threadId });
    assert.doesNotMatch((await prompts())[1], /<instructions>/, "nothing changed");
    await saturn.api("PATCH", `/agents/${agent.id}`, { instructions: "You know the workbench." });
    await runToEnd(saturn, agent.id, { input: "three", threadId: first.threadId });
    await runToEnd(saturn, agent.id, { input: "four", threadId: first.threadId });
    const said = await prompts();
    assert.match(said[2], /<instructions>\nYou know the workbench\.\n<\/instructions>/, "the thread hears what changed");
    assert.doesNotMatch(said[2], /<memory>|Be brief/);
    assert.doesNotMatch(said[3], /<instructions>/, "and only once");
    assert.ok((await started(saturn)).slice(1).every((program) => program.args.join(" ").includes("resume thread-A")), "the same thread throughout");
  } finally {
    await saturn.stop();
  }
});

test("A thread with no record of what it heard is told the instructions: an existing chat, or a turn that failed", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "codex", { model: "default", instructions: "You know the workbench." });
    await saturn.scenario({ steps: [{ send: { type: "thread.started", thread_id: "thread-A" } }, { exit: 1, stderr: "it broke" }] });
    const first = await runToEnd(saturn, agent.id, { input: "one" });
    assert.equal(first.status, "failed");
    await saturn.scenario({
      steps: [
        { send: { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } } },
        { send: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
    });
    await runToEnd(saturn, agent.id, { input: "two", threadId: first.threadId });
    await runToEnd(saturn, agent.id, { input: "three", threadId: first.threadId });
    const programs = await started(saturn);
    assert.ok(programs[1].args.join(" ").includes("resume thread-A"), programs[1].args.join(" "));
    const prompts = (await saturn.journal()).filter((entry) => entry.prompt !== undefined).map((entry) => entry.prompt);
    assert.match(prompts[1], /<instructions>\nYou know the workbench\.\n<\/instructions>/);
    assert.doesNotMatch(prompts[2], /<instructions>/, "once it has gone through, not again");
  } finally {
    await saturn.stop();
  }
});

test("A resumed Claude Code session gets instructions that changed", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { instructions: "Be brief.", autonomy: "bypass" });
    await saturn.scenario({ steps: [{ send: { type: "system", subtype: "init", session_id: "session-1" } }, { send: { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "session-1", usage: { input_tokens: 1, output_tokens: 1 } } }] });
    const first = await runToEnd(saturn, agent.id, { input: "one" });
    assert.equal(first.status, "completed", first.error);
    await saturn.api("PATCH", `/agents/${agent.id}`, { instructions: "You know the workbench." });
    const second = await runToEnd(saturn, agent.id, { input: "two", threadId: first.threadId });
    assert.equal(second.status, "completed", second.error);
    const programs = await started(saturn);
    assert.ok(programs[1].args.includes("--resume=session-1"), programs[1].args.join(" "));
    const initialize = (await received(saturn)).filter((message) => message.request?.subtype === "initialize").at(-1);
    assert.match(initialize.request.appendSystemPrompt, /You know the workbench\./);
    // The real program ignores new text on a resume unless its snapshot is off, whatever is sent; this stand-in does not keep one.
    assert.equal(initialize.request.systemPromptSnapshot, false);
  } finally {
    await saturn.stop();
  }
});

test("Ask and Plan turns run in Codex's read-only sandbox, with the mode's note and images as files", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "codex", { model: "default" });
    await saturn.scenario({ steps: [{ send: { type: "turn.completed", usage: {} } }] });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==";
    const run = await runToEnd(saturn, agent.id, { input: "what is here?", mode: "ask", images: [`data:image/png;base64,${png}`] });
    assert.equal(run.status, "completed", run.error);
    const [program] = await started(saturn);
    assert.equal(program.args[program.args.indexOf("--sandbox") + 1], "read-only");
    const image = program.args[program.args.indexOf("--image") + 1];
    assert.ok(existsSync(image), `${image} is a file the program can read`);
    assert.equal(program.args.at(-2), "--image");
    const prompt = (await saturn.journal()).find((entry) => entry.prompt !== undefined).prompt;
    assert.match(prompt, /what is here\?$/);
    assert.notEqual(prompt, "what is here?", "the mode's note goes first");
  } finally {
    await saturn.stop();
  }
});

test("A Codex turn that fails says why, or how to sign in", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "codex", { model: "default" });
    await saturn.scenario({ steps: [{ send: { type: "turn.failed", error: { message: "401 Unauthorized: not logged in" } } }] });
    assert.match((await runToEnd(saturn, agent.id, { input: "hi" })).error, /Codex isn't signed in for Saturn yet\. Sign in under Settings → General → Codex\./);
    await saturn.scenario({ steps: [{ send: { type: "error", message: "the sandbox broke" } }] });
    assert.equal((await runToEnd(saturn, agent.id, { input: "hi" })).error, "the sandbox broke");
    await saturn.scenario({ steps: [{ exit: 7, stderr: "it crashed\n" }] });
    assert.match((await runToEnd(saturn, agent.id, { input: "hi" })).error, /Codex Exec exited with code 7: it crashed/);
  } finally {
    await saturn.stop();
  }
});

test("Saturn's skills reach Codex over /agent-mcp with a token only that turn holds, and Review asks for them", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "codex", { model: "default", autonomy: "review", mcpConnectionIds: ["automations"] });
    const call = { name: "automation_list", arguments: {} };
    const item = { id: "mcp1", type: "mcp_tool_call", server: "saturn", tool: "automation_list", arguments: {} };
    await saturn.scenario({
      steps: [
        { send: { type: "thread.started", thread_id: "thread-M" } },
        { skills: { rpc: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stand-in", version: "1" } } } },
        { skills: { rpc: "tools/list", id: 2 } },
        { send: { type: "item.started", item: { ...item, status: "in_progress" } } },
        { wait: 100 },
        { skills: { rpc: "tools/call", id: 3, params: call } },
        { send: { type: "item.completed", item: { ...item, status: "completed", result: { content: [{ type: "text", text: "listed" }] } } } },
        { skills: { rpc: "tools/call", id: 4, params: call } },
        { send: { type: "item.completed", item: { ...item, id: "mcp2", status: "failed", error: { message: "Denied" } } } },
        { skills: { rpc: "tools/call", id: 5, params: { name: "no_such_tool", arguments: {} } } },
        { send: { type: "turn.completed", usage: {} } },
      ],
    });
    const begun = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "list" });
    const card = await untilCard(saturn, begun.id);
    assert.deepEqual([card.action.id, card.action.toolId, card.action.reason], ["mcp1", "automation_list", "automation_list needs your approval"]);
    await saturn.api("POST", `/runs/${begun.id}/actions/mcp1/decision`, { allow: true });
    const second = await saturn.until("the next card", () => saturn.api("GET", `/runs/${begun.id}`), (run) => run.status === "waiting_approval" && run.actions.some((action) => action.id !== "mcp1" && action.status === "waiting_approval"));
    const waiting = second.actions.find((action) => action.status === "waiting_approval");
    await saturn.api("POST", `/runs/${begun.id}/actions/${waiting.id}/decision`, { allow: false });
    const done = await untilFinished(saturn, begun.id);
    assert.equal(done.status, "completed", done.error);
    assert.deepEqual(done.actions.map((action) => [action.toolId, action.status]), [["automation_list", "completed"], ["automation_list", "denied"]]);

    const [program] = await started(saturn);
    const settings = program.args.filter((argument) => argument.startsWith("mcp_servers.saturn."));
    assert.deepEqual(settings.sort(), [
      "mcp_servers.saturn.bearer_token_env_var=\"SATURN_SKILLS_TOKEN\"",
      "mcp_servers.saturn.default_tools_approval_mode=\"approve\"",
      "mcp_servers.saturn.tool_timeout_sec=3600",
      `mcp_servers.saturn.url="${saturn.origin}/agent-mcp"`,
    ]);
    assert.match(program.env.SATURN_SKILLS_TOKEN, /^[0-9a-f]{64}$/);

    const skills = (await saturn.journal()).filter((entry) => entry.skills);
    assert.deepEqual(skills.map((entry) => [entry.skills, entry.status]), [["initialize", 200], ["tools/list", 200], ["tools/call", 200], ["tools/call", 200], ["tools/call", 200]]);
    assert.deepEqual(skills[0].body.result.serverInfo, { name: "saturn", version: "1.0.0" });
    assert.ok(skills[1].body.result.tools.some((tool) => tool.name === "automation_list"));
    assert.deepEqual(JSON.parse(skills[2].body.result.content[0].text), { total: 0, filter: "all", automations: [] });
    assert.deepEqual(skills[3].body.result, { content: [{ type: "text", text: "Denied by the user" }], isError: true });
    assert.deepEqual(skills[4].body.result, { content: [{ type: "text", text: "Unknown tool: no_such_tool" }], isError: true });

    // The token ended with the turn; no other token ever opened the endpoint.
    const after = await fetch(`${saturn.origin}/agent-mcp`, { method: "POST", headers: { authorization: `Bearer ${program.env.SATURN_SKILLS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.deepEqual([after.status, await after.json()], [401, { error: "Unauthorized" }]);
    const none = await fetch(`${saturn.origin}/agent-mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(none.status, 401);
  } finally {
    await saturn.stop();
  }
});

test("The skills endpoint only takes POST, and an Ask turn refuses a skill that changes things", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "codex", { model: "default", autonomy: "bypass", mcpConnectionIds: ["automations"] });
    await saturn.scenario({
      steps: [
        { skills: { method: "GET" } },
        { skills: { rpc: "tools/call", id: 2, params: { name: "automation_list", arguments: {} } } },
        { skills: { rpc: "tools/call", id: 3, params: { name: "automation_delete", arguments: { id: "x" } } } },
        { send: { type: "turn.completed", usage: {} } },
      ],
    });
    const run = await runToEnd(saturn, agent.id, { input: "what is here?", mode: "ask" });
    assert.equal(run.status, "completed", run.error);
    const skills = (await saturn.journal()).filter((entry) => entry.skills);
    assert.deepEqual([skills[0].status, skills[0].body], [405, { error: "Method not allowed" }]);
    assert.equal(skills[1].body.result.isError, undefined);
    assert.equal(skills[2].body.result.isError, true);
    assert.match(skills[2].body.result.content[0].text, /read/i);
  } finally {
    await saturn.stop();
  }
});

test("In a group, a Codex member resumes one thread for all its turns", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "codex", { model: "default", autonomy: "bypass" });
    await saturn.scenario({
      steps: [
        { send: { type: "thread.started", thread_id: "thread-G" } },
        { send: { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } } },
        { send: { type: "turn.completed", usage: {} } },
      ],
    });
    const group = await saturn.api("POST", "/groups", { name: "Team", agentIds: [agent.id] });
    const settled = () => saturn.until("the group", () => saturn.api("GET", `/groups/${group.id}/messages`), (transcript) => transcript.runs.length > 0 && transcript.runs.every((run) => ["completed", "failed", "cancelled"].includes(run.status)));
    await saturn.api("POST", `/groups/${group.id}/messages`, { text: "first task" });
    await saturn.until("a turn", () => started(saturn), (list) => list.length === 1);
    await settled();
    assert.equal((await saturn.api("GET", "/groups")).find((item) => item.id === group.id).sessions?.[agent.id]?.codexThreadId, "thread-G");
    await saturn.api("POST", `/groups/${group.id}/messages`, { text: "second task" });
    await saturn.until("a second turn", () => started(saturn), (list) => list.length === 2);
    const programs = await started(saturn);
    assert.equal(programs[0].args.includes("resume"), false);
    assert.ok(programs[1].args.join(" ").includes("resume thread-G"));
    await settled();
  } finally {
    await saturn.stop();
  }
});

test("Stopping a Codex turn ends the program and closes its token", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "codex", { model: "default", autonomy: "bypass", mcpConnectionIds: ["automations"] });
    await saturn.scenario({ steps: [{ send: { type: "thread.started", thread_id: "thread-S" } }, { hang: true }] });
    const begun = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "go" });
    await saturn.until("the program", () => started(saturn), (list) => list.length === 1);
    await saturn.until("the program to read its prompt", () => saturn.journal(), (entries) => entries.some((entry) => entry.prompt !== undefined));
    await saturn.api("POST", `/runs/${begun.id}/stop`, {});
    assert.equal((await saturn.api("GET", `/runs/${begun.id}`)).status, "cancelled");
    await saturn.until("the program to end", () => saturn.journal(), (entries) => entries.some((entry) => entry.signal === "SIGTERM"));
    const [program] = await started(saturn);
    await saturn.until("the token to close", async () => (await fetch(`${saturn.origin}/agent-mcp`, { method: "POST", headers: { authorization: `Bearer ${program.env.SATURN_SKILLS_TOKEN}`, "content-type": "application/json" }, body: "{}" })).status, (status) => status === 401);
  } finally {
    await saturn.stop();
  }
});

test("In a group, a Claude Code member keeps one session of its own, and the group's approval setting wins over the agent's", async () => {
  const saturn = await startWithPrograms();
  try {
    const agent = await coder(saturn, "claude-code", { autonomy: "bypass" });
    const group = await saturn.api("POST", "/groups", { name: "Team", agentIds: [agent.id] });
    await saturn.api("PATCH", `/groups/${group.id}`, { autonomy: "review" });
    await saturn.scenario({ steps: [{ send: { type: "system", subtype: "init", session_id: "session-G" } }, { permission: { tool: "Bash", input: { command: "ls" }, id: "tu_group" } }, result("done", "session-G")] });
    const transcript = () => saturn.api("GET", `/groups/${group.id}/messages`);
    await saturn.api("POST", `/groups/${group.id}/messages`, { text: "first task" });
    const waiting = await saturn.until("the card", transcript, (item) => item.runs.some((run) => run.status === "waiting_approval"));
    const run = waiting.runs.find((item) => item.status === "waiting_approval");
    assert.equal(run.actions.find((action) => action.status === "waiting_approval").id, "tu_group", "Bypass on the agent, Review in the group");
    await saturn.api("POST", `/runs/${run.id}/actions/tu_group/decision`, { allow: true });
    await saturn.until("the turn", transcript, (item) => item.runs.every((one) => ["completed", "failed", "cancelled"].includes(one.status)));
    assert.equal((await saturn.api("GET", "/groups")).find((item) => item.id === group.id).sessions?.[agent.id]?.claudeSessionId, "session-G");
    await saturn.api("POST", `/groups/${group.id}/messages`, { text: "second task" });
    const programs = await saturn.until("a second turn", () => started(saturn), (list) => list.length === 2);
    assert.ok(programs[1].args.includes("--resume=session-G"), programs[1].args.join(" "));
    // The program is on record as started before it has read anything, so wait for the turn's own message.
    const messages = await saturn.until("the second turn's message", () => received(saturn), (list) => list.some((message) => message.type === "user" && JSON.stringify(message).includes("second task")));
    const second = messages.find((message) => message.type === "user" && JSON.stringify(message).includes("second task"));
    assert.doesNotMatch(JSON.stringify(second), /first task/, "what the session already saw is not sent again");
  } finally {
    await saturn.stop();
  }
});
