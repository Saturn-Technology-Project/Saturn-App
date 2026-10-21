import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PublicAddress } from "../../domain/skills/public-address.js";
import { launchEnv } from "../launch-env.js";
import { errorText, logger } from "../logger.js";
import { SafariBrowser } from "./safari-browser.js";

/**
 * A browser the agent drives through the Chrome DevTools Protocol: pages read as an accessibility tree (one
 * element per line with an id), clicks and typing by element id or CSS selector, screenshots, and screencast
 * recording to a file. Much faster and steadier than screenshot-and-coordinates computer use: the agent reads
 * text and names, not pixels. The browser is Chrome or Chromium when installed, else Saturn's own Electron with
 * a hidden window, so it works on a machine with no Chrome at all.
 *
 * Two ways for the user to watch it, set in Settings → General → Agent browser:
 * - "saturn" (default): the browser runs without a window and its page streams live into the Agent App's Browser
 *   panel (`frames()`), the way Codex shows its own browser;
 * - "system": a visible window of the installed Chrome (Edge, Brave…), with Saturn's own profile, never the user's;
 * - "safari": a Safari automation window on macOS, through safaridriver (see safari-browser.ts).
 * Every way a cursor drawn in the page moves to what the agent points at and ripples when it clicks.
 */

export type BrowserMode = "saturn" | "system" | "safari";

/** One frame of the page as the agent's browser shows it, for the live view. */
export type BrowserFrame = { data: string; format?: "jpeg" | "png"; width: number; height: number; url: string; title: string };

/** The cursor drawn into every page: a pointer that glides to a point, and a ripple on click. Hidden from the accessibility tree. */
const CURSOR_SCRIPT = `(() => {
  if (window.__saturnCursor) return;
  const make = () => {
    if (document.getElementById("__saturn_cursor")) return document.getElementById("__saturn_cursor");
    const cursor = document.createElement("div");
    cursor.id = "__saturn_cursor";
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .28s cubic-bezier(.2,.8,.2,1);transform:translate(-40px,-40px);";
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8-6.5 1.6L8.6 18z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(cursor);
    return cursor;
  };
  window.__saturnCursor = {
    move(x, y) { make().style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px)"; },
    click(x, y) {
      this.move(x, y);
      const ring = document.createElement("div");
      ring.setAttribute("aria-hidden", "true");
      ring.style.cssText = "position:fixed;left:" + (x - 14) + "px;top:" + (y - 14) + "px;width:28px;height:28px;border-radius:50%;border:2px solid #4f8cff;z-index:2147483646;pointer-events:none;opacity:.9;transition:transform .45s ease-out,opacity .45s ease-out;";
      (document.body || document.documentElement).appendChild(ring);
      requestAnimationFrame(() => { ring.style.transform = "scale(1.8)"; ring.style.opacity = "0"; });
      setTimeout(() => ring.remove(), 500);
    },
  };
})();`;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
/** Elements per snapshot, so a long page does not flood the model. */
const SNAPSHOT_LIMIT = 400;
/** How long the browser stays open after the last call. */
const IDLE_MS = 5 * 60_000;

type Target = { id: string; url: string; title: string };

/** One CDP connection: numbered requests over a websocket, with session routing and event listeners. */
class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, ((params: Record<string, unknown>, sessionId?: string) => void)[]>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (message.id !== undefined && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Could not connect to the browser"));
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, listener: (params: Record<string, unknown>, sessionId?: string) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  close(): void {
    this.ws.close();
  }
}

type AxNode = { nodeId: string; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; ignored?: boolean; childIds?: string[]; properties?: { name: string; value: { value?: unknown } }[] };

export class BrowserSkill {
  private child?: ChildProcess;
  private mode: BrowserMode = "saturn";
  /** Live viewers of the page; the screencast runs while there is one, or a recording. */
  private readonly viewers = new Set<(frame: BrowserFrame) => void>();
  private screencasting = false;
  private current = { url: "about:blank", title: "" };
  private cdp?: Cdp;
  private session?: string;
  private port = 0;
  private idle?: NodeJS.Timeout;
  /** Snapshot ids → backend DOM node ids, so clicks name the element the agent saw. */
  private nodes = new Map<number, number>();
  private recording?: { file: string; frames: number; started: number; chunks: string[] };

  private readonly safari: SafariBrowser;

  /** `safariEndpoint`: an already running WebDriver server to use instead of safaridriver (tests). */
  constructor(private readonly dataDir: string, safariEndpoint?: string) {
    this.safari = new SafariBrowser(dataDir, {
      watched: () => this.viewers.size > 0,
      emit: (frame) => {
        for (const viewer of this.viewers) viewer(frame);
      },
      cursorScript: CURSOR_SCRIPT,
    }, safariEndpoint);
  }

  /** Which browser to use from the next launch; a running browser of the other kind is closed. */
  async setMode(mode: BrowserMode): Promise<void> {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.child) await this.close();
    if (this.safari.open) await this.safari.close();
  }

  /** What the live view shows when it opens. */
  state(): { open: boolean; mode: BrowserMode; url: string; title: string } {
    if (this.mode === "safari") return { open: this.safari.open, mode: this.mode, ...this.safari.state() };
    return { open: Boolean(this.cdp), mode: this.mode, ...this.current };
  }

  /** Subscribes to the page's frames (while the browser is open); returns the unsubscribe. */
  frames(listener: (frame: BrowserFrame) => void): () => void {
    this.viewers.add(listener);
    void this.syncScreencast();
    this.safari.sync();
    return () => {
      this.viewers.delete(listener);
      void this.syncScreencast();
      this.safari.sync();
    };
  }

  /** One screencast for live viewers and recordings together: on while either needs it. */
  private async syncScreencast(): Promise<void> {
    const wanted = Boolean(this.cdp && this.session && (this.viewers.size || this.recording));
    if (wanted === this.screencasting || !this.cdp || !this.session) return;
    this.screencasting = wanted;
    if (wanted) await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }, this.session).catch(() => { this.screencasting = false; });
    else await this.cdp.send("Page.stopScreencast", {}, this.session).catch(() => undefined);
  }

  /** Moves the drawn cursor to (x, y), or ripples it there for a click, and gives the motion time to show. */
  private async pointAt(x: number, y: number, click = false): Promise<void> {
    if (!this.cdp || !this.session) return;
    await this.cdp.send("Runtime.evaluate", { expression: `window.__saturnCursor && window.__saturnCursor.${click ? "click" : "move"}(${Math.round(x)}, ${Math.round(y)})` }, this.session).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, click ? 120 : 300));
  }

  async run(toolId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error("Operation aborted");
    this.touch();
    if (this.mode === "safari") return this.safari.run(toolId, args);
    switch (toolId) {
      case "browser_navigate":
        return this.navigate(String(args.url ?? ""));
      case "browser_snapshot":
        return this.snapshot();
      case "browser_click":
        return this.click(args);
      case "browser_type":
        return this.type(args);
      case "browser_press":
        return this.press(String(args.key ?? ""));
      case "browser_scroll":
        return this.scroll(args);
      case "browser_screenshot":
        return this.screenshot(args);
      case "browser_evaluate":
        return this.evaluate(String(args.expression ?? ""));
      case "browser_record_start":
        return this.recordStart(args);
      case "browser_record_stop":
        return this.recordStop();
      case "browser_close":
        await this.close();
        return { closed: true };
      default:
        throw new Error(`Unknown browser tool: ${toolId}`);
    }
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  /** The browser to drive: an installed Chrome/Chromium, else Saturn's own Electron with a hidden window. */
  private launchCommand(): { command: string; args: string[] } {
    const port = this.port;
    const profile = path.join(this.dataDir, "browser-profile");
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const chrome = process.env.SATURN_BROWSER || CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
    if (chrome) {
      // "system": a real window the user watches; "saturn": no window, the page streams into Saturn's Browser panel.
      const visible = this.mode === "system";
      return { command: chrome, args: [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...(visible ? [] : ["--headless=new"]), "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1280,860", "about:blank"] };
    }
    // Electron: the runtime runs on it when packaged (process.execPath), or the desktop's dev copy.
    const electron = process.versions.electron ? process.execPath : process.env.SATURN_ELECTRON;
    if (!electron) throw new Error("No browser found. Install Google Chrome (or Chromium), or set SATURN_BROWSER to a Chrome binary.");
    const app = path.join(this.dataDir, "browser-app");
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "saturn-browser", main: "main.cjs" }));
    writeFileSync(
      path.join(app, "main.cjs"),
      [
        'const { app, BrowserWindow } = require("electron");',
        `app.commandLine.appendSwitch("remote-debugging-port", "${port}");`,
        `app.setPath("userData", ${JSON.stringify(profile)});`,
        `app.whenReady().then(() => { const w = new BrowserWindow({ show: ${this.mode === "system"}, title: "Saturn Agent Browser", width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true } }); w.loadURL("about:blank"); });`,
        'app.on("window-all-closed", () => {});',
      ].join("\n"),
    );
    return { command: electron, args: [app] };
  }

  private async ensure(): Promise<{ cdp: Cdp; session: string }> {
    if (this.cdp && this.session) return { cdp: this.cdp, session: this.session };
    this.port = 9500 + Math.floor(Math.random() * 400);
    const { command, args } = this.launchCommand();
    const env = launchEnv();
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, args, { stdio: "ignore", env });
    this.child = child;
    // A binary that cannot start (ENOENT, EACCES) reports through "error"; without a listener it would crash the runtime.
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
    });
    this.child.on("exit", () => {
      this.cdp?.close();
      this.cdp = undefined;
      this.session = undefined;
      this.child = undefined;
    });
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let attempt = 0; attempt < 40 && !version; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (spawnError) {
        this.child = undefined;
        throw new Error(`The browser could not start: ${spawnError.message.replace(/^spawn /, "")}. Install Google Chrome, or set SATURN_BROWSER to a Chrome binary.`);
      }
      try {
        version = (await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
      } catch {
        // not up yet
      }
    }
    if (!version) {
      child.kill();
      this.child = undefined;
      throw new Error(`The browser did not start (${path.basename(command)})`);
    }
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const targets = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as Target[];
    let page = targets.find((target) => (target as { type?: string }).type === "page");
    if (!page) {
      const created = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
      page = { id: created.targetId, url: "about:blank", title: "" };
    }
    const attached = (await cdp.send("Target.attachToTarget", { targetId: page.id, flatten: true })) as { sessionId: string };
    await cdp.send("Page.enable", {}, attached.sessionId);
    await cdp.send("Runtime.enable", {}, attached.sessionId);
    await cdp.send("Accessibility.enable", {}, attached.sessionId);
    await cdp.send("DOM.enable", {}, attached.sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, attached.sessionId);
    // The visible cursor, in every page from now on and in this one.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CURSOR_SCRIPT }, attached.sessionId);
    await cdp.send("Runtime.evaluate", { expression: CURSOR_SCRIPT }, attached.sessionId).catch(() => undefined);
    // Frames go to live viewers and to a recording in progress.
    cdp.on("Page.screencastFrame", (params, sessionId) => {
      if (sessionId !== attached.sessionId) return;
      const frame = params as { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } };
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }, attached.sessionId).catch(() => undefined);
      const recording = this.recording;
      if (recording) {
        recording.frames += 1;
        const file = path.join(recording.file, `frame-${String(recording.frames).padStart(5, "0")}.jpg`);
        writeFileSync(file, Buffer.from(frame.data, "base64"));
        recording.chunks.push(`file '${path.basename(file)}'`);
      }
      const shown: BrowserFrame = { data: frame.data, format: "jpeg", width: frame.metadata?.deviceWidth ?? 1280, height: frame.metadata?.deviceHeight ?? 800, ...this.current };
      for (const viewer of this.viewers) viewer(shown);
    });
    cdp.on("Page.frameNavigated", (params, sessionId) => {
      const navigated = params as { frame?: { url?: string; parentId?: string } };
      if (sessionId === attached.sessionId && navigated.frame && !navigated.frame.parentId && navigated.frame.url) this.current = { url: navigated.frame.url, title: this.current.title };
    });
    cdp.on("Page.loadEventFired", (_params, sessionId) => {
      if (sessionId !== attached.sessionId) return;
      void cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, attached.sessionId).then((result) => {
        this.current = { ...this.current, title: String((result as { result?: { value?: unknown } }).result?.value ?? "") };
      }, () => undefined);
    });
    this.cdp = cdp;
    this.session = attached.sessionId;
    this.screencasting = false;
    void this.syncScreencast();
    logger.info("browser", `Browser started (${path.basename(command)}) on port ${this.port}`);
    return { cdp, session: attached.sessionId };
  }

  async close(): Promise<void> {
    if (this.safari.open) await this.safari.close();
    if (this.recording) await this.recordStop().catch(() => undefined);
    this.cdp?.close();
    this.child?.kill();
    this.cdp = undefined;
    this.session = undefined;
    this.child = undefined;
    this.screencasting = false;
    this.current = { url: "about:blank", title: "" };
    this.nodes.clear();
  }

  private async navigate(raw: string) {
    const url = PublicAddress.parse(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).url.toString();
    const { cdp, session } = await this.ensure();
    const loaded = new Promise<void>((resolve) => {
      const done = () => resolve();
      cdp.on("Page.loadEventFired", done);
      setTimeout(done, 15_000);
    });
    const result = (await cdp.send("Page.navigate", { url }, session)) as { errorText?: string };
    if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`);
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const info = (await cdp.send("Runtime.evaluate", { expression: "JSON.stringify({ title: document.title, url: location.href })", returnByValue: true }, session)) as { result: { value: string } };
    return { ...JSON.parse(info.result.value), snapshot: await this.snapshotText() };
  }

  /** The page as an accessibility tree: "[id] role name=… value=…", indented, interactive elements first-class. */
  private async snapshot() {
    return { snapshot: await this.snapshotText() };
  }

  private async snapshotText(): Promise<string> {
    const { cdp, session } = await this.ensure();
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree", {}, session)) as { nodes: AxNode[] };
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const lines: string[] = [];
    this.nodes.clear();
    let next = 1;
    const visit = (node: AxNode, depth: number) => {
      if (lines.length >= SNAPSHOT_LIMIT) return;
      const role = node.role?.value ?? "";
      const name = String(node.name?.value ?? "").trim();
      const value = node.value?.value;
      const skip = node.ignored || ["none", "generic", "InlineTextBox", "LineBreak", "StaticText"].includes(role) && !name;
      if (!skip && role && (name || value !== undefined || /button|link|textbox|combobox|checkbox|radio|tab|menuitem|heading|searchbox|slider|switch|option|listbox|image/.test(role))) {
        const id = next++;
        if (node.backendDOMNodeId !== undefined) this.nodes.set(id, node.backendDOMNodeId);
        const extra = (node.properties ?? []).filter((prop) => ["checked", "expanded", "disabled", "selected", "focused", "pressed"].includes(prop.name) && prop.value?.value !== undefined && prop.value.value !== false).map((prop) => `${prop.name}=${String(prop.value.value)}`);
        const parts = [`[${id}] ${role}`];
        if (name) parts.push(`name=${JSON.stringify(name.slice(0, 120))}`);
        if (value !== undefined && value !== "") parts.push(`value=${JSON.stringify(String(value).slice(0, 120))}`);
        parts.push(...extra);
        lines.push(`${"  ".repeat(Math.min(depth, 12))}${parts.join(" ")}`);
      }
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) visit(child, skip ? depth : depth + 1);
      }
    };
    const root = nodes.find((node) => node.role?.value === "RootWebArea") ?? nodes[0];
    if (root) visit(root, 0);
    if (lines.length >= SNAPSHOT_LIMIT) lines.push(`… (more elements; scroll or navigate to see the rest)`);
    return lines.join("\n") || "(empty page)";
  }

  /** The element the agent means: a snapshot id, or a CSS selector. */
  private async resolve(args: Record<string, unknown>): Promise<{ objectId: string; backendNodeId?: number }> {
    const { cdp, session } = await this.ensure();
    if (args.id !== undefined) {
      const backendNodeId = this.nodes.get(Number(args.id));
      if (backendNodeId === undefined) throw new Error(`No element [${String(args.id)}] in the last snapshot. Call browser_snapshot and use an id from it.`);
      const { object } = (await cdp.send("DOM.resolveNode", { backendNodeId }, session)) as { object: { objectId: string } };
      return { objectId: object.objectId, backendNodeId };
    }
    const selector = String(args.selector ?? "").trim();
    if (!selector) throw new Error("Give an element id from the snapshot, or a CSS selector.");
    const { result } = (await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` }, session)) as { result: { objectId?: string; subtype?: string } };
    if (!result.objectId || result.subtype === "null") throw new Error(`Nothing matches the selector ${selector}`);
    return { objectId: result.objectId };
  }

  private async click(args: Record<string, unknown>) {
    const { cdp, session } = await this.ensure();
    const target = await this.resolve(args);
    await cdp.send("Runtime.callFunctionOn", { objectId: target.objectId, functionDeclaration: "function () { this.scrollIntoView({ block: 'center', inline: 'center' }); }" }, session);
    const { model } = (await cdp.send("DOM.getBoxModel", { objectId: target.objectId }, session).catch(() => ({ model: undefined }))) as { model?: { content: number[] } };
    if (model) {
      const [x1, y1, x2, , , y3] = model.content;
      const x = (x1! + x2!) / 2;
      const y = (y1! + y3!) / 2;
      // The cursor glides there and ripples, so whoever watches sees what is clicked.
      await this.pointAt(x, y);
      await this.pointAt(x, y, true);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, session);
      }
    } else {
      await cdp.send("Runtime.callFunctionOn", { objectId: target.objectId, functionDeclaration: "function () { this.click(); }" }, session);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { clicked: true, snapshot: await this.snapshotText() };
  }

  private async type(args: Record<string, unknown>) {
    const { cdp, session } = await this.ensure();
    const text = String(args.text ?? "");
    if (args.id !== undefined || args.selector) {
      const target = await this.resolve(args);
      const { model } = (await cdp.send("DOM.getBoxModel", { objectId: target.objectId }, session).catch(() => ({ model: undefined }))) as { model?: { content: number[] } };
      if (model) await this.pointAt((model.content[0]! + model.content[2]!) / 2, (model.content[1]! + model.content[5]!) / 2, true);
      await cdp.send("Runtime.callFunctionOn", { objectId: target.objectId, functionDeclaration: "function () { this.focus(); if ('select' in this) this.select(); }" }, session);
      if (args.clear !== false) await cdp.send("Runtime.callFunctionOn", { objectId: target.objectId, functionDeclaration: "function () { if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); } }" }, session);
    }
    await cdp.send("Input.insertText", { text }, session);
    if (args.submit) await this.press("Enter");
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { typed: text.length, snapshot: await this.snapshotText() };
  }

  private async press(key: string) {
    const { cdp, session } = await this.ensure();
    const named: Record<string, { key: string; code: string; keyCode: number }> = {
      enter: { key: "Enter", code: "Enter", keyCode: 13 }, tab: { key: "Tab", code: "Tab", keyCode: 9 }, escape: { key: "Escape", code: "Escape", keyCode: 27 },
      backspace: { key: "Backspace", code: "Backspace", keyCode: 8 }, delete: { key: "Delete", code: "Delete", keyCode: 46 }, space: { key: " ", code: "Space", keyCode: 32 },
      arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }, arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }, arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      pageup: { key: "PageUp", code: "PageUp", keyCode: 33 }, pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 }, home: { key: "Home", code: "Home", keyCode: 36 }, end: { key: "End", code: "End", keyCode: 35 },
    };
    const parts = key.split("+").map((part) => part.trim());
    const last = parts.pop() ?? "";
    const modifiers = parts.reduce((bits, part) => bits | ({ alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 }[part.toLowerCase()] ?? 0), 0);
    const spec = named[last.toLowerCase()] ?? { key: last, code: `Key${last.toUpperCase()}`, keyCode: last.toUpperCase().charCodeAt(0) };
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, modifiers, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, ...(type === "keyDown" && spec.key.length === 1 ? { text: spec.key } : {}) }, session);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { pressed: key, snapshot: await this.snapshotText() };
  }

  private async scroll(args: Record<string, unknown>) {
    const { cdp, session } = await this.ensure();
    const direction = ["up", "down", "left", "right"].includes(String(args.direction)) ? String(args.direction) : "down";
    const amount = Math.max(100, Math.min(5000, Number(args.pixels) || 600));
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    await cdp.send("Runtime.evaluate", { expression: `window.scrollBy(${dx}, ${dy})` }, session);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { scrolled: direction, snapshot: await this.snapshotText() };
  }

  private async screenshot(args: Record<string, unknown>) {
    const { cdp, session } = await this.ensure();
    const { data } = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70, ...(args.fullPage ? { captureBeyondViewport: true } : {}) }, session)) as { data: string };
    const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : undefined;
    if (file) {
      const target = path.resolve(this.dataDir, "workspace", file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(data, "base64"));
      return { file: target, bytes: Buffer.byteLength(data, "base64") };
    }
    return { image: `data:image/jpeg;base64,${data}`, width: 1280, height: 800 };
  }

  private async evaluate(expression: string) {
    const { cdp, session } = await this.ensure();
    if (!expression.trim()) throw new Error("Give a JavaScript expression");
    const { result, exceptionDetails } = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session)) as { result: { value?: unknown; description?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return { value: result.value ?? result.description ?? null };
  }

  /** Records the page as a series of JPEG frames (a screencast) into a folder; stop writes an index. */
  private async recordStart(args: Record<string, unknown>) {
    await this.ensure();
    if (this.recording) throw new Error("Already recording; call browser_record_stop first.");
    const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().replace(/[^\w.-]/g, "_") : `recording-${Date.now().toString(36)}`;
    const folder = path.resolve(this.dataDir, "workspace", "recordings", name);
    await mkdir(folder, { recursive: true });
    const recording = { file: folder, frames: 0, started: Date.now(), chunks: [] as string[] };
    this.recording = recording;
    // The frames come from the screencast the live view shares (see ensure()).
    await this.syncScreencast();
    return { recording: folder, note: "Frames are saved as JPEGs; browser_record_stop writes frames.txt for ffmpeg (ffmpeg -f concat -i frames.txt -r 10 out.mp4)." };
  }

  private async recordStop() {
    const recording = this.recording;
    if (!recording) throw new Error("Not recording.");
    this.recording = undefined;
    await this.syncScreencast();
    await writeFile(path.join(recording.file, "frames.txt"), recording.chunks.map((line) => `${line}\nduration 0.1`).join("\n") + "\n");
    return { recording: recording.file, frames: recording.frames, seconds: Math.round((Date.now() - recording.started) / 100) / 10 };
  }
}

export function describeBrowserError(error: unknown): string {
  return errorText(error);
}
