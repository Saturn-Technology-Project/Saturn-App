import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { realFetch, useRuntimeAuth } from "./runtime-token.js";

/** Reads server-sent events from a response body into a list, until `stop` is called. */
function collect(body: ReadableStream<Uint8Array>) {
  const events: { event: string; data: unknown }[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (finished) return;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  return { events, stop: () => reader.cancel().catch(() => undefined), done };
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("the event streams tell which runs changed, and stream one run as it changes", async () => {
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      // A slow answer, so the run is seen running before it completes.
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "streamed answer" } }] }));
      }, 150);
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-events-")));
  await store.load();
  const { app, services } = createApp(store);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  useRuntimeAuth(base);
  try {
    const connection = await services.createModel({ name: "Slow", provider: "openai", baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}` });
    const agent = await services.createAgent({ name: "Streamer", modelConnectionId: connection.id });

    const all = await fetch(`${base}/events`);
    assert.equal(all.headers.get("content-type"), "text/event-stream");
    const changes = collect(all.body!);
    await waitFor(() => changes.events.find((item) => item.event === "ready"), "ready");

    const run = await services.startRun(agent.id, "hello");
    const one = await fetch(`${base}/runs/${run.id}/events`);
    const runEvents = collect(one.body!);

    const finished = await waitFor(() => runEvents.events.map((item) => item.data as { status: string; output: string }).find((item) => item.status === "completed"), "the completed run");
    assert.equal(finished.output, "streamed answer");
    assert.equal((runEvents.events[0]!.data as { id: string }).id, run.id, "the stream opens with the run as it is");

    const mentioned = await waitFor(() => changes.events.find((item) => item.event === "change" && (item.data as { runs: { id: string; status: string }[] }).runs.some((entry) => entry.id === run.id && entry.status === "completed")), "a change naming the completed run");
    assert.ok(mentioned);
    // Agents and chats changed too (a new agent, a new chat): "other" is set on some change.
    await services.createAgent({ name: "Another" });
    await waitFor(() => changes.events.find((item) => item.event === "change" && (item.data as { other: boolean }).other), "a change to something other than runs");

    const missing = await fetch(`${base}/runs/run_missing/events`);
    assert.equal(missing.status, 404);
    const unauthorized = await realFetch(`${base}/events`);
    assert.equal(unauthorized.status, 401, "the streams need the token like every route");
    changes.stop();
    runEvents.stop();
  } finally {
    server.close();
    model.close();
  }
});
