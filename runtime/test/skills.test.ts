import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expandCommand, listCommands, listSkills, loadSkill, parseSkill, skillsPrompt } from "../src/application/skill-files.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { toolSteps } from "./tool-steps.js";

async function writeSkill(dir: string, folder: string, text: string, extra: Record<string, string> = {}) {
  await mkdir(path.join(dir, folder), { recursive: true });
  await writeFile(path.join(dir, folder, "SKILL.md"), text);
  for (const [name, content] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(dir, folder, name)), { recursive: true });
    await writeFile(path.join(dir, folder, name), content);
  }
}

test("skills are found in the project's folders, then the user's; the first of a name wins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "saturn-skills-"));
  const project = path.join(root, "project");
  const user = path.join(root, "user-skills");
  await writeSkill(path.join(project, ".agents", "skills"), "deploy", "---\nname: deploy\ndescription: Ship a preview build\n---\n# Deploy\n1. Build\n2. Upload", { "scripts/upload.sh": "echo up" });
  await writeSkill(path.join(project, ".claude", "skills"), "review", "# Review\n\nRead the diff and list risks before approving.\n");
  await writeSkill(user, "deploy", "---\nname: deploy\ndescription: The user's own deploy\n---\nIgnored when the project has one.");
  await writeSkill(user, "standup", "---\ndescription: Write today's standup\n---\nSummarize yesterday's commits.");
  await mkdir(path.join(user, "not-a-skill"), { recursive: true });

  const skills = await listSkills(project, user);
  assert.deepEqual(skills.map((item) => [item.name, item.source, item.description]), [
    ["deploy", "project", "Ship a preview build"],
    ["review", "project", "Read the diff and list risks before approving."],
    ["standup", "user", "Write today's standup"],
  ]);
  assert.deepEqual((await listSkills(undefined, user)).map((item) => item.name), ["deploy", "standup"], "outside a project: the user's only");

  const deploy = await loadSkill(project, user, "/deploy");
  assert.equal(deploy?.instructions, "# Deploy\n1. Build\n2. Upload");
  assert.deepEqual(deploy?.files, ["scripts/upload.sh"]);
  assert.equal(await loadSkill(project, user, "nope"), undefined);

  assert.deepEqual(parseSkill("no frontmatter\n\nsecond", "x"), { name: "x", description: "no frontmatter", body: "no frontmatter\n\nsecond" });
  const prompt = skillsPrompt(skills);
  assert.match(prompt, /^# Skills/);
  assert.match(prompt, /- deploy: Ship a preview build/);
  assert.equal(skillsPrompt([]), "");
});

test("an agent sees the skills in its prompt and loads one with the skill tool; the rule and skill tools write in the project", async () => {
  const requests: { system: string; lastResult: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const steps = toolSteps(messages);
      const last = steps.length ? JSON.stringify(steps) : "";
      requests.push({ system: messages.find((item) => item.role === "system")?.content ?? "", lastResult: last });
      const done = steps.length;
      const calls = [
        { name: "skill", arguments: { name: "deploy" } },
        { name: "customizations_create_skill", arguments: { name: "made-here", description: "Made by the agent", instructions: "Steps" } },
      ];
      const next = calls[done];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: next ? { content: "", tool_calls: [{ id: `c${done}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.arguments) } }] } : { content: "deployed" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-skills-run-"));
  const folder = path.join(directory, "site");
  await writeSkill(path.join(folder, ".agents", "skills"), "deploy", "---\nname: deploy\ndescription: Ship a preview build\n---\nRun the build, then upload.");
  try {
    const store = new FileStore(path.join(directory, "data"));
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: `http://127.0.0.1:${address.port}` });
    const agent = await services.createAgent({ name: "Shipper", modelConnectionId: connection.id, autonomy: "bypass" });
    const automations = store.state.mcp.find((item) => item.id === "automations" || item.id === "antigravity-skills");
    assert.ok(automations, "the built-in automations tools are installed");
    await services.updateAgent(agent.id, { mcpConnectionIds: [...agent.mcpConnectionIds, automations.id] });
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);
    const thread = await services.kernel.runs.createThread(agent.id, "Ship", project.id);
    const run = await services.startRun(agent.id, "ship it", thread.id);
    let done: Run = services.kernel.getRun(run.id);
    for (let attempt = 0; attempt < 300 && (done.status === "running" || done.status === "queued"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      done = services.kernel.getRun(run.id);
    }
    assert.equal(done.status, "completed", done.error);
    assert.match(requests[0]!.system, /# Skills[\s\S]*- deploy: Ship a preview build/, "the prompt lists the skill");
    const loaded = done.actions.find((item) => item.toolId === "skill");
    assert.equal(loaded?.status, "completed");
    assert.equal((loaded!.result as { instructions: string }).instructions, "Run the build, then upload.");
    assert.equal(done.actions.find((item) => item.toolId === "customizations_create_skill")?.status, "completed");
    assert.ok(await stat(path.join(folder, ".agents", "skills", "made-here", "SKILL.md")), "the new skill is in the project, not the runtime's folder");
  } finally {
    server.close();
  }
});

test("prompt commands: the project's .saturn and .claude commands, then the user's; $ARGUMENTS is filled in", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "saturn-commands-"));
  const project = path.join(root, "project");
  const user = path.join(root, "user-commands");
  await mkdir(path.join(project, ".claude", "commands"), { recursive: true });
  await mkdir(user, { recursive: true });
  await writeFile(path.join(project, ".claude", "commands", "explain.md"), "---\ndescription: Explain a file\n---\nExplain $ARGUMENTS simply.");
  await writeFile(path.join(user, "standup.md"), "Write my standup.");
  await writeFile(path.join(user, "explain.md"), "Shadowed by the project's.");
  assert.deepEqual((await listCommands(project, user)).map((item) => [item.name, item.source, item.description]), [["explain", "project", "Explain a file"], ["standup", "user", "Write my standup."]]);
  assert.deepEqual(await expandCommand(project, user, "/explain", "util.ts"), { name: "explain", prompt: "Explain util.ts simply." });
  assert.deepEqual(await expandCommand(project, user, "standup", "for Friday"), { name: "standup", prompt: "Write my standup.\n\nfor Friday" });
  assert.equal(await expandCommand(project, user, "missing", ""), undefined);
});
