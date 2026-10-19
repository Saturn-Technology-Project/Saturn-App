import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLIENT_TTL_MS, ClientRegistry, LAUNCH_GRACE_MS } from "../src/application/clients.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { useRuntimeAuth } from "./runtime-token.js";

test("IDE clients count while they report in, and while Saturn has just opened one", () => {
  const clients = new ClientRegistry();
  const start = 1_000_000;
  assert.deepEqual(clients.list(start), []);

  // Saturn opened the IDE: it counts for the launch grace period, then lapses if it never reports in.
  clients.expect("ide", start);
  assert.equal(clients.list(start + LAUNCH_GRACE_MS - 1).length, 1);
  assert.equal(clients.list(start + LAUNCH_GRACE_MS + 1).length, 0);

  // A heartbeat keeps it; silence past the TTL drops it; leaving drops it at once.
  clients.beat("ide:a", "ide", start);
  assert.deepEqual(clients.list(start + CLIENT_TTL_MS - 1).map((item) => item.id), ["ide:a"]);
  assert.equal(clients.list(start + CLIENT_TTL_MS + 1).length, 0);
  clients.beat("ide:b", "ide", start);
  clients.leave("ide:b");
  assert.equal(clients.list(start).length, 0);
});

test("the client routes register, list and remove an IDE window", async () => {
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-clients-")));
  await store.load();
  const { app } = createApp(store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  useRuntimeAuth(base);
  try {
    const posted = await fetch(`${base}/runtime/clients`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ide:1", kind: "ide" }) });
    assert.equal(posted.status, 200);
    assert.deepEqual(((await (await fetch(`${base}/runtime/clients`)).json()) as { id: string }[]).map((item) => item.id), ["ide:1"]);
    assert.equal((await fetch(`${base}/runtime/clients/ide%3A1`, { method: "DELETE" })).status, 204);
    assert.deepEqual(await (await fetch(`${base}/runtime/clients`)).json(), []);
    assert.equal((await fetch(`${base}/runtime/clients`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});
