// What a sandboxed command cannot reach: Saturn's own data (its token, its keys, the conversations) and the usual
// credential folders. A command that could read the token could use the runtime's API to turn its own sandbox off and
// allow itself; one that could read the keys could send them anywhere. Driven through a chat in the default approval
// mode, where a command that matches no risky pattern runs without a card.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, command } from "./files-support.mjs";

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
  // One command that the risky patterns miss (the token's name is a glob here, as an injected command can make it), so
  // the default mode does not ask: it reads the token and tries to use it. Only the sandbox stands in the way.
  const token_glob = `'${data}'/runtime-tok*`;
  const steal = [
    `cat ${token_glob}`,
    `cat '${path.join(data, "state.json")}' | head -c 64`,
    `T=$(cat ${token_glob} 2>/dev/null)`,
    `curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"sandbox":{"mode":"off"}}' ${saturn.runtime.origin}/projects/${projectId}`,
    `for f in ${token_glob}; do echo x > "$f"; done`,
  ].join("; ");
  const run = await setup.turn([command(steal)], "summarize the README");
  const action = run.actions[0];
  assert.equal(action.status, "completed", "no card: the command matched no risky pattern");
  if (!sandboxed(t, action.result)) return;
  const said = `${action.result.stdout}${action.result.stderr}`;
  assert.ok(!said.includes(token), "the token never reached the command");
  assert.match(action.result.stdout, /401/, "without the token the runtime refuses the change");
  assert.equal((await readFile(path.join(data, "runtime-token"), "utf8")).trim(), token, "and the token file is unchanged");
  const project = (await saturn.api("GET", "/projects")).find((item) => item.id === projectId);
  assert.equal(project.sandbox, undefined, "the project's sandbox is as it was");
  assert.match(action.result.stderr, /credential folders/, "the model is told why");
});

test("a chat outside any project still works in its own folder inside Saturn's data, but not in the rest of it", async (t) => {
  const setup = await saturn.chat();
  const run = await setup.turn([
    command("echo kept > notes.txt && cat notes.txt"),
    command("cat ../runtime-token"),
  ]);
  const [own, around] = run.actions;
  if (!sandboxed(t, own.result)) return;
  assert.equal(own.result.exitCode, 0, JSON.stringify(own.result));
  assert.equal(own.result.stdout, "kept\n");
  assert.notEqual(around.result.exitCode, 0, JSON.stringify(around.result));
  assert.equal(around.result.stdout, "");
});
