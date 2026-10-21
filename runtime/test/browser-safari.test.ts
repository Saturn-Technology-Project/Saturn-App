import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserSkill, type BrowserFrame } from "../src/infrastructure/skills/browser-skill.js";
import { SAFARI_SETUP } from "../src/infrastructure/skills/safari-browser.js";

const ELEMENT = "element-6066-11e4-a52f-4a8f-b8c4-f3bc2b7a1b40";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** A WebDriver server standing in for safaridriver: records the commands, answers like Safari would. */
async function fakeSafaridriver(options: { refuse?: string } = {}) {
  const seen: string[] = [];
  const scripts: string[] = [];
  let url = "about:blank";
  const server = createServer(async (req, res) => {
    const route = (req.url ?? "").replace(/^\/session\/s1/, "");
    const sent = await body(req);
    seen.push(`${req.method} ${route}`);
    res.setHeader("content-type", "application/json");
    const answer = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify({ value }));
    };
    if (req.method === "POST" && req.url === "/session") {
      if (options.refuse) return answer({ error: "session not created", message: options.refuse }, 500);
      return answer({ sessionId: "s1", capabilities: { browserName: "Safari" } });
    }
    if (route === "/url" && req.method === "POST") {
      url = String(sent.url);
      return answer(null);
    }
    if (route === "/url") return answer(url);
    if (route === "/title") return answer("Demo page");
    if (route === "/element") return answer(sent.value === "#missing" ? null : { [ELEMENT]: "e1" }, sent.value === "#missing" ? 404 : 200);
    if (route === "/execute/sync") {
      const script = String(sent.script);
      scripts.push(script);
      if (script.includes("data-saturn-ref")) return answer('[1] heading name="Demo"\n[2] button name="Go"');
      if (script.includes("getBoundingClientRect()")) return answer({ x: 300, y: 230 });
      return answer(null);
    }
    if (route === "/execute/async") return answer({ ok: 42 });
    if (route === "/screenshot") return answer(PNG);
    return answer(null);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, scripts, server, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("in Safari mode the agent's tools become WebDriver commands, with the cursor, screenshots for the live view, and recordings", async () => {
  const driver = await fakeSafaridriver();
  const browser = new BrowserSkill(await mkdtemp(path.join(os.tmpdir(), "saturn-safari-")), driver.endpoint);
  await browser.setMode("safari");
  const frames: BrowserFrame[] = [];
  const stop = browser.frames((frame) => frames.push(frame));
  try {
    const opened = (await browser.run("browser_navigate", { url: "example.com" })) as { url: string; title: string; snapshot: string };
    assert.equal(opened.url, "https://example.com/");
    assert.equal(opened.title, "Demo page");
    assert.match(opened.snapshot, /\[2\] button name="Go"/);
    assert.deepEqual(browser.state(), { open: true, mode: "safari", url: "https://example.com/", title: "Demo page" });
    await assert.rejects(browser.run("browser_navigate", { url: "http://127.0.0.1:4700/" }), /not allowed/, "loopback stays refused");

    // A click: the element by its snapshot id, the cursor drawn there, then WebDriver's click.
    await browser.run("browser_click", { id: 2 });
    assert.ok(driver.seen.includes("POST /element/e1/click"));
    assert.ok(driver.scripts.some((script) => script.includes("__saturnCursor.move(arguments[0], arguments[1])")));
    await browser.run("browser_type", { selector: "#q", text: "hello", submit: true });
    assert.ok(driver.seen.includes("POST /element/e1/clear") && driver.seen.includes("POST /element/e1/value") && driver.seen.includes("POST /actions"));
    await assert.rejects(browser.run("browser_click", { selector: "#missing" }), /Nothing matches the selector #missing/);
    assert.deepEqual(await browser.run("browser_evaluate", { expression: "6 * 7" }), { value: 42 });

    // The live view gets PNG screenshots with the page's URL.
    const frame = await until(() => frames.at(-1), "a live frame");
    assert.equal(frame.format, "png");
    assert.equal(frame.url, "https://example.com/");

    const started = (await browser.run("browser_record_start", {})) as { recording: string };
    await until(() => (frames.length > 3 ? true : undefined), "frames while recording");
    const stopped = (await browser.run("browser_record_stop", {})) as { recording: string; frames: number };
    assert.equal(stopped.recording, started.recording);
    assert.ok(stopped.frames >= 1);
    assert.ok((await readdir(stopped.recording)).includes("frames.txt"));

    // Back to Saturn's own browser: the Safari session ends.
    await browser.setMode("saturn");
    assert.ok(driver.seen.includes("DELETE "));
    assert.equal(browser.state().open, false);
  } finally {
    stop();
    await browser.close();
    driver.server.close();
  }
});

test("Safari without remote automation says how to turn it on", async () => {
  const driver = await fakeSafaridriver({ refuse: "You must enable 'Allow remote automation' in the Develop menu to control Safari via WebDriver." });
  const browser = new BrowserSkill(await mkdtemp(path.join(os.tmpdir(), "saturn-safari-off-")), driver.endpoint);
  await browser.setMode("safari");
  try {
    await assert.rejects(browser.run("browser_snapshot", {}), (error: Error) => error.message === SAFARI_SETUP);
    assert.equal(browser.state().open, false);
  } finally {
    driver.server.close();
  }
});
