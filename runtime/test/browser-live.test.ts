import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BrowserSkill, type BrowserFrame } from "../src/infrastructure/skills/browser-skill.js";

// A real browser: installed Chrome, or the desktop's dev Electron. Skipped when neither is there (CI without one).
const here = path.dirname(fileURLToPath(import.meta.url));
const electron = path.resolve(here, "..", "..", "desktop", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const chromes = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"];
const available = Boolean(process.env.SATURN_BROWSER) || chromes.some((item) => existsSync(item)) || existsSync(electron);

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("the agent's browser streams its page to live viewers with a visible cursor, and recordings share the stream", { skip: !available && "no Chrome or Electron here" }, async () => {
  if (!process.env.SATURN_BROWSER && !chromes.some((item) => existsSync(item))) process.env.SATURN_ELECTRON = electron;
  const site = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><title>Demo page</title><body style="margin:0;height:3000px"><button id="go" style="margin:200px;width:200px;height:60px" onclick="this.textContent=\'clicked\'">Go</button></body>');
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  const browser = new BrowserSkill(await mkdtemp(path.join(os.tmpdir(), "saturn-browser-live-")));
  const frames: BrowserFrame[] = [];
  const stop = browser.frames((frame) => frames.push(frame));
  try {
    assert.equal(browser.state().open, false);
    // browser_navigate refuses loopback addresses, so the local test page is opened from inside the page.
    await browser.run("browser_evaluate", { expression: `location.href = ${JSON.stringify(url)}` });
    assert.equal(browser.state().open, true);
    assert.equal(browser.state().mode, "saturn");
    await until(() => (browser.state().title === "Demo page" ? true : undefined), "the page title");
    assert.equal(browser.state().url, url);

    // The cursor is in the page, hidden from the agent's snapshot.
    const snapshot = JSON.stringify(await browser.run("browser_snapshot", {}));
    assert.match(snapshot, /Go/);
    assert.ok(!snapshot.includes("__saturn_cursor"));
    await browser.run("browser_click", { selector: "#go" });
    const where = (await browser.run("browser_evaluate", { expression: "[document.getElementById('go').textContent, getComputedStyle(document.getElementById('__saturn_cursor')).transform]" })) as { value?: unknown } | unknown[];
    const [text, transform] = (Array.isArray(where) ? where : (where as { value: unknown[] }).value) as [string, string];
    assert.equal(text, "clicked");
    assert.match(transform, /matrix\(1, 0, 0, 1, (2\d\d|3\d\d)/, "the cursor moved onto the button (x ≈ 300)");

    // Live frames arrive with the page's URL; a recording uses the same stream and keeps it running after it stops.
    await until(() => (frames.length > 0 ? true : undefined), "a live frame");
    assert.equal(frames.at(-1)!.url, url);
    assert.ok(Buffer.from(frames.at(-1)!.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "a JPEG");
    const started = (await browser.run("browser_record_start", {})) as { recording: string };
    await browser.run("browser_scroll", { direction: "down", pixels: 300 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const stopped = (await browser.run("browser_record_stop", {})) as { recording: string; frames: number };
    assert.equal(stopped.recording, started.recording);
    assert.ok((await readdir(stopped.recording)).some((name) => name.endsWith(".jpg")));
    const before = frames.length;
    await browser.run("browser_scroll", { direction: "up", pixels: 300 });
    await until(() => (frames.length > before ? true : undefined), "frames after the recording stopped");
  } finally {
    stop();
    await browser.run("browser_close", {}).catch(() => undefined);
    site.close();
    delete process.env.SATURN_ELECTRON;
  }
  assert.equal(browser.state().open, false);
});
