// Skills found in a project's folders, the user's and the plugins', whichever language runs them.
import assert from "node:assert/strict";
import { mkdir, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { open } from "./config-harness.mjs";

let saturn;
const skill = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

before(async () => {
  saturn = await open();
  // The user's own, in the data folder.
  await saturn.folder("data/skills", {
    "deploy/SKILL.md": skill("deploy", "The user's own deploy", "Ignored when the project has one."),
    "standup/SKILL.md": "---\ndescription: Write today's standup\n---\nSummarize yesterday's commits.",
    "not-a-skill/notes.txt": "no SKILL.md here",
  });
});
after(async () => {
  await saturn?.close();
});

const pairs = (skills) => skills.map((item) => [item.name, item.source, item.description]);

test("skills are found in the project's folders, then the user's; the first of a name wins", async () => {
  const root = await saturn.folder("found", {
    ".agents/skills/deploy/SKILL.md": skill("deploy", "Ship a preview build", "# Deploy\n1. Build\n2. Upload"),
    ".agents/skills/deploy/scripts/upload.sh": "echo up",
    ".saturn/skills/deploy/SKILL.md": skill("deploy", "Second of the name", "Ignored."),
    ".saturn/skills/lint/SKILL.md": skill("lint", "Lint it", "Run the linter."),
    ".claude/skills/review/SKILL.md": "# Review\n\nRead the diff and list risks before approving.\n",
    ".claude/skills/bad name/SKILL.md": "A folder name a skill cannot have.",
    ".claude/skills/empty/notes.txt": "no SKILL.md",
  });
  const project = await saturn.api("POST", "/projects", { path: root, grant: true });
  assert.deepEqual(pairs(await saturn.api("GET", `/skills?projectId=${project.id}`)), [
    ["deploy", "project", "Ship a preview build"],
    ["lint", "project", "Lint it"],
    ["review", "project", "Read the diff and list risks before approving."],
    ["standup", "user", "Write today's standup"],
  ]);
  assert.deepEqual((await saturn.api("GET", "/skills")).map((item) => item.name), ["deploy", "standup"], "outside a project: the user's only");
  assert.equal((await saturn.api("GET", "/skills/deploy")).description, "The user's own deploy");

  const deploy = await saturn.api("GET", `/skills/deploy?projectId=${project.id}`);
  assert.equal(deploy.instructions, "# Deploy\n1. Build\n2. Upload");
  assert.deepEqual(deploy.files, ["scripts/upload.sh"], "the other files in its folder");
  assert.equal(deploy.name, "deploy");
  assert.equal(deploy.description, "Ship a preview build");
  assert.equal((await saturn.api("GET", `/skills/DEPLOY?projectId=${project.id}`)).name, "deploy", "the composer's /name, in any case");
  assert.equal((await saturn.api("GET", `/skills/%2Fdeploy?projectId=${project.id}`)).name, "deploy");
  await saturn.refused("GET", `/skills/nope?projectId=${project.id}`, undefined, 404);
});

test("a project without access gives no skills of its own", async () => {
  const root = await saturn.folder("closed", { ".saturn/skills/secret/SKILL.md": skill("secret", "Closed", "x") });
  const project = await saturn.api("POST", "/projects", { path: root });
  await saturn.refused("GET", `/skills?projectId=${project.id}`, undefined, 403);
  await saturn.refused("GET", `/skills/secret?projectId=${project.id}`, undefined, 403);
});

test("the user's own skills folder may hold a link to elsewhere, since it is theirs", async () => {
  const outside = await saturn.folder("outside-skill", { "SKILL.md": skill("linked", "From elsewhere", "Linked instructions.") });
  await mkdir(path.join(saturn.dataDir, "skills/linked"), { recursive: true });
  await symlink(path.join(outside, "SKILL.md"), path.join(saturn.dataDir, "skills/linked/SKILL.md"));
  assert.equal((await saturn.api("GET", "/skills/linked")).instructions, "Linked instructions.");
});

test("an agent sees the skills in its prompt and loads one with the skill tool; a new skill goes in the project", async () => {
  const root = await saturn.folder("in-a-run", { ".agents/skills/ship/SKILL.md": skill("ship", "Ship a preview build", "Run the build, then upload.") });
  const setup = await saturn.chat({
    root,
    autonomy: "bypass",
    mcpConnectionIds: ["general-skills", "automations"],
    steps: [
      ["skill", { name: "ship" }],
      ["skill", { name: "nothing-like-it" }],
      ["customizations_create_skill", { name: "made-here", description: "Made by the agent", instructions: "Steps" }],
    ],
  });
  // A project's skills come with its folder: the user allows them first.
  const seen = await saturn.api("GET", `/projects/${setup.project.id}/instructions`);
  await saturn.api("POST", `/projects/${setup.project.id}/instructions/approve`, { fingerprint: seen.fingerprint });
  const run = await saturn.finished((await saturn.start(setup, "ship it")).id);
  assert.equal(run.status, "completed", run.error);
  const system = setup.model.requests.find((body) => body.tools?.length).messages.find((item) => item.role === "system").content;
  assert.match(system, /# Skills[\s\S]*- ship: Ship a preview build/, "names and descriptions");
  assert.doesNotMatch(system, /Run the build, then upload/, "not the instructions, until asked");
  const [loaded, missing, made] = run.actions;
  assert.equal(loaded.status, "completed");
  assert.equal(loaded.result.instructions, "Run the build, then upload.");
  assert.equal(missing.status, "failed");
  assert.match(missing.reason, /ship/, "it names the ones there are");
  assert.equal(made.status, "completed");
  assert.ok(await stat(path.join(root, ".agents/skills/made-here/SKILL.md")), "in the project, not the runtime's folder");
  assert.ok((await saturn.api("GET", `/skills?projectId=${setup.project.id}`)).some((item) => item.name === "made-here"));
});
