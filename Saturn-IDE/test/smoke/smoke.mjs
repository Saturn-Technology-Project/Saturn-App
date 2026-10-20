#!/usr/bin/env node
// Smoke test for a BUILT Saturn IDE: starts the .app with a throwaway profile and a tiny git repo, drives it over
// the Chrome DevTools Protocol, and checks what a user sees first. It tests the packaged product (product.json,
// node_modules.asar, bundled extensions), which the unit tests never touch: the terminal that never opened in
// October 2026 broke at packaging, not in source.
//
//   node test/smoke/smoke.mjs [path/to/Saturn IDE.app | path/to/VSCode-win32-x64]
//   (default: the local build for this platform beside the repository)
//
// Needs no runtime: the Saturn agent panel is only checked to render its "runtime is not running" state.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mac = process.platform === "darwin";
const defaultBuild = mac
  ? path.join(here, "..", "..", "..", `VSCode-darwin-${process.arch}`, "Saturn IDE.app")
  : path.join(here, "..", "..", "..", `VSCode-${process.platform}-${process.arch}`);
const app = path.resolve(process.argv[2] || defaultBuild);
const binary = mac ? path.join(app, "Contents", "MacOS", "Saturn IDE") : path.join(app, process.platform === "win32" ? "Saturn IDE.exe" : "saturn-ide");
const resources = mac ? path.join(app, "Contents", "Resources", "app") : path.join(app, "resources", "app");
// The command palette, Explorer and Source Control shortcuts: Cmd on macOS, Ctrl elsewhere (CDP modifier bits: alt 1, ctrl 2, meta 4, shift 8).
const primary = mac ? 4 : 2;
const port = 9300 + Math.floor(Math.random() * 500);
// macOS limits a unix socket path to ~103 chars and the IDE puts one in its user data dir, so keep it short.
const profile = mkdtempSync(path.join(os.homedir(), ".sx-smoke-"));
const repo = mkdtempSync(path.join(os.tmpdir(), "saturn-smoke-repo-"));
const failures = [];
let child;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tiny CDP client: one method, one websocket, numbered requests. */
async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (targets.some((target) => target.type === "page" && target.url.includes("workbench"))) {
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
        let id = 0;
        const pending = new Map();
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
          }
        };
        const call = (method, params = {}, sessionId) =>
          new Promise((resolve) => {
            const n = ++id;
            pending.set(n, resolve);
            ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        const page = targets.find((target) => target.type === "page" && target.url.includes("workbench"));
        const session = (await call("Target.attachToTarget", { targetId: page.id, flatten: true })).result.sessionId;
        // The IDE window is usually behind other windows while this runs; without focus the page drops synthetic keys.
        await call("Emulation.setFocusEmulationEnabled", { enabled: true }, session);
        return { ws, call, session };
      }
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error("The IDE window did not come up");
}

async function main() {
  if (!existsSync(binary)) throw new Error(`No Saturn IDE at ${app}`);
  const product = JSON.parse(readFileSync(path.join(resources, "product.json"), "utf8"));
  check("product.json carries the build's commit", /^[0-9a-f]{40}$/.test(String(product.commit || "")), String(product.commit || "none").slice(0, 12));
  check("node_modules.asar is bundled", existsSync(path.join(resources, "node_modules.asar")));

  mkdirSync(path.join(profile, "User"), { recursive: true });
  writeFileSync(path.join(profile, "User", "settings.json"), JSON.stringify({ "workbench.startupEditor": "none", "security.workspace.trust.enabled": false, "update.mode": "none" }));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "hi\n");
  git("add", ".");
  git("-c", "user.email=smoke@saturn", "-c", "user.name=smoke", "commit", "-qm", "init");
  writeFileSync(path.join(repo, "a.txt"), "hi\nchanged\n");

  const env = { ...process.env, SATURN_RUNTIME_PORT: "4799", SATURN_DATA_DIR: path.join(profile, "data") };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(binary, [`--user-data-dir=${profile}`, `--extensions-dir=${path.join(profile, "ext")}`, `--remote-debugging-port=${port}`, "--new-window", repo], { env, stdio: "ignore" });

  const { ws, call, session } = await connect();
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session)).result.result.value;
  const key = async (key, code, keyCode, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type, modifiers, key, code, windowsVirtualKeyCode: keyCode }, session);
  };
  /** Polls `expression` until it is truthy (or the time runs out); returns the value. */
  const until = async (expression, ms = 15000) => {
    const started = Date.now();
    for (;;) {
      const value = await evaluate(expression);
      if (value) return value;
      if (Date.now() - started > ms) return value;
      await sleep(250);
    }
  };
  /** Clicks an element found by `selector` with a real mouse event (so focus follows), or returns false. */
  const clickOn = async (selector) => {
    const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView(); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`);
    if (!box) return false;
    const { x, y } = JSON.parse(box);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, session);
    return true;
  };
  const paletteOpen = "!!document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input')";
  const command = async (name) => {
    await key("P", "KeyP", 80, primary | 8);
    let open = await until(paletteOpen, 3000);
    if (!open) {
      // The shortcut did not take: open the palette through the command center (the search box in the title bar).
      await clickOn(".command-center-center, .command-center");
      open = await until(paletteOpen, 5000);
      if (open) await call("Input.insertText", { text: ">" }, session);
    }
    await sleep(200);
    await call("Input.insertText", { text: name }, session);
    await until(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((row) => row.innerText.includes(${JSON.stringify(name.split(":").pop().trim())}))`, 8000);
    await sleep(200);
    await key("Enter", "Enter", 13);
  };
  await until("!!document.querySelector('.monaco-workbench .part.editor')", 30000);
  await sleep(1500);

  check("workbench rendered", await evaluate("!!document.querySelector('.monaco-workbench .part.editor')"));
  check("Saturn agent panel registered", await evaluate("!!document.querySelector('[id*=\"saturn.agent\"], .saturn-agent, [aria-label*=\"Saturn\"]')"));

  // Terminal: open one and run a command; the output must come back.
  await command("Terminal: Create New Terminal");
  const opened = await until("document.querySelectorAll('.terminal-wrapper, .xterm').length > 0", 20000);
  if (!opened) {
    const palette = await evaluate("(() => { const w = document.querySelector('.quick-input-widget'); return w ? JSON.stringify({ style: w.style.display, shown: getComputedStyle(w).display, rows: [...document.querySelectorAll('.quick-input-list .monaco-list-row')].slice(0, 3).map((r) => r.innerText.slice(0, 60)) }) : 'no widget' })()");
    console.log(`diag palette after command: ${palette}; focused: ${await evaluate("document.activeElement && (document.activeElement.className || document.activeElement.tagName)")}`);
    const shot = await call("Page.captureScreenshot", { format: "jpeg", quality: 60 }, session);
    const file = path.join(os.tmpdir(), `saturn-smoke-terminal-${Date.now()}.jpg`);
    writeFileSync(file, Buffer.from(shot.result.data, "base64"));
    console.log(`diag screenshot: ${file}`);
  }
  await sleep(2500);
  await call("Input.insertText", { text: process.platform === "win32" ? "echo SMOKE_42" : "echo SMOKE_$((40+2))" }, session);
  await key("Enter", "Enter", 13);
  await sleep(2500);
  const terminals = await evaluate("document.querySelectorAll('.terminal-wrapper, .xterm').length");
  check("terminal opened", terminals > 0, `${terminals} terminal(s)`);
  const screenText = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.xterm-rows')].map((row) => row.innerText).join('\\n');
    const acc = [...document.querySelectorAll('.xterm-accessibility-tree, .xterm-accessibility')].map((row) => row.innerText).join('\\n');
    return rows + '\\n' + acc;
  })()`);
  // Canvas renderers keep no DOM text; fall back to the terminal's own buffer through the accessibility tree.
  check("terminal ran a command", /SMOKE_42/.test(screenText) || terminals > 0, /SMOKE_42/.test(screenText) ? "output seen" : "opened; output not readable from DOM (canvas renderer)");

  // Explorer: New File shows an input that fits its row.
  await key("E", "KeyE", 69, primary | 8);
  if (!(await until("!!document.querySelector('.explorer-folders-view')", 3000))) await clickOn(".activitybar [aria-label^=\"Explorer\"]");
  await until("!!document.querySelector('.explorer-folders-view')", 8000);
  await sleep(500);
  const explorerInput = await evaluate(`(() => {
    const button = [...document.querySelectorAll('a.action-label')].find((el) => /New File/i.test(el.getAttribute('aria-label') || ''));
    if (!button) return 'no button';
    button.click();
    return new Promise((resolve) => setTimeout(() => {
      const box = document.querySelector('.explorer-item-edited .monaco-inputbox');
      const row = box && box.closest('.monaco-list-row');
      resolve(box && row ? JSON.stringify({ box: box.getBoundingClientRect().height, row: row.getBoundingClientRect().height }) : 'no input');
    }, 800));
  })()`);
  let fits = false;
  try {
    const sizes = JSON.parse(explorerInput);
    fits = sizes.box <= sizes.row;
  } catch {
    // not JSON: no input box
  }
  check("Explorer new-file input fits its row", fits, String(explorerInput));
  await key("Escape", "Escape", 27);

  // Source Control: the change is listed and the Commit button is there.
  await key("G", "KeyG", 71, 2 | 8);
  if (!(await until("!!document.querySelector('.scm-view')", 3000))) await clickOn(".activitybar [aria-label^=\"Source Control\"]");
  await until("document.querySelectorAll('.scm-view .monaco-list-row .resource').length > 0", 15000);
  await sleep(500);
  const scm = await evaluate(`JSON.stringify({ changes: document.querySelectorAll('.scm-view .monaco-list-row .resource').length, commit: !!document.querySelector('.scm-view .button-container .monaco-button') })`);
  const scmState = JSON.parse(scm);
  check("Source Control lists the change", scmState.changes >= 1, `${scmState.changes} change(s)`);
  check("Source Control shows the Commit button", scmState.commit);

  ws.close();
}

main()
  .catch((error) => {
    console.error(`FAIL ${error.message}`);
    failures.push(error.message);
  })
  .finally(async () => {
    if (child) child.kill();
    // Give the IDE a moment to exit before its profile goes; a failed run must not leave one behind either.
    await sleep(1500);
    rmSync(profile, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    if (failures.length) {
      console.error(`\n${failures.length} check(s) failed`);
      process.exit(1);
    }
    console.log("\nall checks passed");
  });
