// What a sandboxed command cannot reach: Saturn's own data (its token, its keys, the conversations) and the usual
// credential folders. A command that could read the token could use the runtime's API to turn its own sandbox off and
// allow itself; one that could read the keys could send them anywhere. Driven through a chat in the default approval
// mode, where a command that matches no risky pattern runs without a card.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, command, node } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

/** Skips the rest of a test, saying why, when this computer could not sandbox the command. */
function sandboxed(t, result) {
  if (result.sandboxed === true) return true;
  t.skip(`no sandbox here: ${result.sandboxNote ?? "unknown"}`);
  return false;
}

test("a sandboxed command can neither read nor change Saturn's token, keys or records, so it cannot loosen its own approvals", async (t) => {
  const data = saturn.runtime.dataDir;
  const token = (await readFile(path.join(data, "runtime-token"), "utf8")).trim();
  await saturn.api("POST", "/connections/models", { name: "Victim", provider: "openai", model: "gpt-x", secret: "sk-sandbox-test-value" });
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "README.md"), "# project\n");
  const setup = await saturn.chat(folder, { autonomy: "execute_when_allowed" });
  const projectId = setup.project.id;
  // One command that the risky patterns miss (the token's name is looked up, not written, as an injected command can do),
  // so the default mode does not ask: it reads the token and tries to use it. Only the sandbox stands in the way. It
  // is Node, so `sh` and `cmd` run the same thing; what it is to reach travels as base64.
  const target = Buffer.from(JSON.stringify({ data, url: `${saturn.runtime.origin}/projects/${projectId}` })).toString("base64");
  const steal = node([
    "const fs = require('fs'), path = require('path')",
    `const { data, url } = JSON.parse(Buffer.from('${target}', 'base64').toString())`,
    "const tried = (what) => { try { return what(); } catch (error) { console.error(error.code || String(error)); return ''; } }",
    "const tokens = tried(() => fs.readdirSync(data).filter((name) => name.startsWith('runtime-tok'))) || ['runtime-' + 'token']",
    "const token = tried(() => fs.readFileSync(path.join(data, tokens[0]), 'utf8'))",
    "console.log(token)",
    "console.log(tried(() => fs.readFileSync(path.join(data, 'state.json'), 'utf8').slice(0, 64)))",
    "tried(() => fs.writeFileSync(path.join(data, tokens[0]), 'x'))",
    "fetch(url, { method: 'PATCH', headers: { authorization: 'Bearer ' + token.trim(), 'content-type': 'application/json' }, body: JSON.stringify({ sandbox: { mode: 'off' } }) })"
      + ".then((answer) => console.log('answered', answer.status), () => console.log('unreachable')).then(() => process.exit(1))",
  ].join("; "));
  const run = await setup.turn([command(steal)], "summarize the README");
  const action = run.actions[0];
  assert.equal(action.status, "completed", "no card: the command matched no risky pattern");
  if (!sandboxed(t, action.result)) return;
  const said = `${action.result.stdout}${action.result.stderr}`;
  assert.ok(!said.includes(token), "the token never reached the command");
  // Without the token the runtime refuses the change. On Windows the command does not get that far: a container
  // cannot reach a server on this computer outside it.
  assert.match(action.result.stdout, process.platform === "win32" ? /answered 401|unreachable/ : /answered 401/);
  assert.equal((await readFile(path.join(data, "runtime-token"), "utf8")).trim(), token, "and the token file is unchanged");
  const project = (await saturn.api("GET", "/projects")).find((item) => item.id === projectId);
  assert.equal(project.sandbox, undefined, "the project's sandbox is as it was");
  assert.match(action.result.stderr, /credential folders/, "the model is told why");
});

test("a chat outside any project still works in its own folder inside Saturn's data, but not in the rest of it", async (t) => {
  const setup = await saturn.chat();
  const run = await setup.turn([
    command(node("require('fs').writeFileSync('notes.txt', 'kept'); console.log(require('fs').readFileSync('notes.txt', 'utf8'))")),
    command(node("console.log(require('fs').readFileSync('../runtime-token', 'utf8'))")),
  ]);
  const [own, around] = run.actions;
  if (!sandboxed(t, own.result)) return;
  assert.equal(own.result.exitCode, 0, JSON.stringify(own.result));
  assert.equal(own.result.stdout, "kept\n");
  assert.notEqual(around.result.exitCode, 0, JSON.stringify(around.result));
  assert.equal(around.result.stdout, "");
});
