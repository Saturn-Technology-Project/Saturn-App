// The interface's one door to the runtime: in the desktop app a request carries the token only once the app has seen its
// own runtime answer on the port, so whatever listens there while the runtime is down is never handed the token.
import assert from "node:assert/strict";
import { test } from "node:test";

let state = "starting";
let asked = 0;
const sent = [];
globalThis.saturnDesktop = {
  runtimeOrigin: () => "http://127.0.0.1:4700",
  runtimeToken: () => "session-token",
  runtimeStatus: async () => {
    asked += 1;
    return { state };
  },
};
globalThis.fetch = async (url, init) => {
  sent.push({ url, authorization: init?.headers?.authorization });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
const { RuntimeClient } = await import("../src/infrastructure/runtime-client.ts");

test("no request leaves while the app has not seen its own runtime, and the token goes once it has", async () => {
  const client = new RuntimeClient();
  for (const waiting of ["starting", "blocked", "failed"]) {
    state = waiting;
    await assert.rejects(client.request("/agents"), /not running yet/);
  }
  assert.deepEqual(sent, [], "nothing was sent, so no token either");

  state = "ready";
  assert.deepEqual(await client.request("/agents"), { ok: true });
  assert.deepEqual(sent, [{ url: "http://127.0.0.1:4700/agents", authorization: "Bearer session-token" }]);

  // The app's answer is taken for a moment rather than asked for every request.
  const before = asked;
  await client.request("/threads");
  assert.equal(asked, before, "asked once for both");
});
