import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PublicAddress } from "../../domain/skills/public-address.js";
import { launchEnv } from "../launch-env.js";
import { logger } from "../logger.js";
import type { BrowserFrame } from "./browser-skill.js";

/**
 * The agent's browser as a window of the user's Safari, driven through Apple's `safaridriver` (WebDriver; Safari
 * has no DevTools protocol). Safari runs it as a separate automation window with a clean state: none of the user's
 * logins, and the user cannot click into it while the agent works. One automation session at a time.
 *
 * Without the DevTools protocol there is no accessibility tree and no screencast, so the snapshot is built by a
 * script in the page (elements marked with `data-saturn-ref`), and the live view and recordings are screenshots.
 */

const SAFARIDRIVER = "/usr/bin/safaridriver";
const SNAPSHOT_LIMIT = 400;
/** How often the live view and a recording take a screenshot. */
const FRAME_MS = 700;
/** WebDriver's element key in responses. */
const ELEMENT = "element-6066-11e4-a52f-4a8f-b8c4-f3bc2b7a1b40";

export const SAFARI_SETUP = "Safari needs remote automation turned on, once: in Safari open Settings → Advanced and tick \"Show features for web developers\", then Develop → Allow Remote Automation (or run `safaridriver --enable` in Terminal). Then try again.";

/** Builds the snapshot in the page: "[id] role name=… value=…", one line per meaningful element, ids kept on the elements. */
const SNAPSHOT_SCRIPT = `
const limit = arguments[0];
const lines = [];
let next = 1;
document.querySelectorAll("[data-saturn-ref]").forEach((el) => el.removeAttribute("data-saturn-ref"));
const implicit = (el) => {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type))) return "button";
  if (tag === "input" && type === "checkbox") return "checkbox";
  if (tag === "input" && type === "radio") return "radio";
  if (tag === "input" && type === "search") return "searchbox";
  if (tag === "input" && type === "range") return "slider";
  if (tag === "input" && type !== "hidden") return "textbox";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "option") return "option";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "img") return "image";
  if (tag === "summary") return "button";
  return "";
};
const visible = (el) => {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
};
const nameOf = (el) => {
  const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
  if (label) return label;
  if (el.id) { const forLabel = document.querySelector("label[for='" + CSS.escape(el.id) + "']"); if (forLabel) return forLabel.innerText; }
  if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return el.getAttribute("placeholder") || "";
  return (el.innerText || "").replace(/\\s+/g, " ");
};
const walk = (el, depth) => {
  if (lines.length >= limit || el.id === "__saturn_cursor" || el.getAttribute("aria-hidden") === "true") return;
  if (!visible(el)) return;
  const role = el.getAttribute("role") || implicit(el);
  let shown = false;
  if (role) {
    const id = next++;
    el.setAttribute("data-saturn-ref", String(id));
    const parts = ["[" + id + "] " + role];
    const name = nameOf(el).trim();
    if (name) parts.push("name=" + JSON.stringify(name.slice(0, 120)));
    if ("value" in el && el.value !== undefined && el.value !== "" && role !== "button" && role !== "option") parts.push("value=" + JSON.stringify(String(el.value).slice(0, 120)));
    if (el.checked) parts.push("checked=true");
    if (el.disabled) parts.push("disabled=true");
    if (document.activeElement === el) parts.push("focused=true");
    lines.push("  ".repeat(Math.min(depth, 12)) + parts.join(" "));
    shown = true;
    if (["link", "button", "heading", "option"].includes(role)) return;
  } else {
    const own = [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent.trim()).join(" ").trim();
    if (own && ["P", "LI", "TD", "TH", "SPAN", "DIV", "LABEL", "DT", "DD", "PRE", "CODE", "STRONG", "EM", "B"].includes(el.tagName)) {
      lines.push("  ".repeat(Math.min(depth, 12)) + "text " + JSON.stringify(own.slice(0, 160)));
    }
  }
  for (const child of el.children) walk(child, shown ? depth + 1 : depth);
};
if (document.body) walk(document.body, 0);
if (lines.length >= limit) lines.push("… (more elements; scroll or navigate to see the rest)");
return lines.join("\\n") || "(empty page)";
`;

const KEYS: Record<string, string> = {
  enter: "", return: "", tab: "", escape: "", esc: "", backspace: "", delete: "", space: " ",
  arrowup: "", arrowdown: "", arrowleft: "", arrowright: "", pageup: "", pagedown: "", home: "", end: "",
};
const MODIFIERS: Record<string, string> = { shift: "", ctrl: "", control: "", alt: "", option: "", meta: "", cmd: "", command: "" };

type Hooks = {
  /** Whether a live viewer wants frames. */
  watched: () => boolean;
  emit: (frame: BrowserFrame) => void;
  cursorScript: string;
};

export class SafariBrowser {
  private driver?: ChildProcess;
  private base?: string;
  private session?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private ticker?: NodeJS.Timeout;
  private current = { url: "about:blank", title: "" };
  private recording?: { file: string; frames: number; started: number; chunks: string[] };

  /** `endpoint` points at an already running WebDriver server instead of starting safaridriver (tests). */
  constructor(private readonly dataDir: string, private readonly hooks: Hooks, private readonly endpoint?: string) {}

  get open(): boolean {
    return Boolean(this.session);
  }

  state(): { url: string; title: string } {
    return { ...this.current };
  }

  /** The live view's frames: a screenshot every FRAME_MS while someone watches or a recording runs. */
  sync(): void {
    const wanted = Boolean(this.session && (this.hooks.watched() || this.recording));
    if (wanted && !this.ticker) {
      this.ticker = setInterval(() => void this.frame(), FRAME_MS);
      this.ticker.unref?.();
    } else if (!wanted && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private async frame(): Promise<void> {
    if (!this.session) return;
    const data = await this.call<string>("GET", "/screenshot").catch(() => undefined);
    if (!data) return;
    const recording = this.recording;
    if (recording) {
      recording.frames += 1;
      const file = path.join(recording.file, `frame-${String(recording.frames).padStart(5, "0")}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      recording.chunks.push(`file '${path.basename(file)}'`);
    }
    if (this.hooks.watched()) this.hooks.emit({ data, format: "png", width: 1280, height: 800, ...this.current });
  }

  /** One WebDriver command at a time (screenshots for the live view interleave with the agent's commands). */
  private call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const run = async () => {
      const response = await fetch(`${this.base}/session/${this.session}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = (await response.json().catch(() => ({}))) as { value?: unknown };
      const value = json.value as { error?: string; message?: string } | undefined;
      if (!response.ok || (value && typeof value === "object" && "error" in value && value.error)) throw new Error(value?.message || value?.error || `Safari: ${response.status}`);
      return json.value as T;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ensure(): Promise<void> {
    if (this.session) return;
    if (this.endpoint) {
      this.base = this.endpoint;
    } else {
      if (process.platform !== "darwin" || !existsSync(SAFARIDRIVER)) throw new Error("Safari is only on macOS. Pick Saturn or Chrome in Settings → General → Agent browser.");
      const port = 9900 + Math.floor(Math.random() * 90);
      const driver = spawn(SAFARIDRIVER, ["--port", String(port)], { stdio: "ignore", env: launchEnv() });
      let spawnError: Error | undefined;
      driver.on("error", (error) => (spawnError = error));
      driver.on("exit", () => {
        this.driver = undefined;
        this.session = undefined;
        this.sync();
      });
      this.driver = driver;
      this.base = `http://127.0.0.1:${port}`;
      let up = false;
      for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (spawnError) throw new Error(`safaridriver could not start: ${spawnError.message}`);
        up = await fetch(`${this.base}/status`).then((response) => response.ok, () => false);
      }
      if (!up) {
        driver.kill();
        throw new Error("safaridriver did not start");
      }
    }
    const response = await fetch(`${this.base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "safari" } } }) });
    const json = (await response.json().catch(() => ({}))) as { value?: { sessionId?: string; error?: string; message?: string } };
    if (!response.ok || !json.value?.sessionId) {
      const message = json.value?.message ?? json.value?.error ?? `status ${response.status}`;
      this.driver?.kill();
      if (/remote automation|Allow Remote Automation|--enable/i.test(message)) throw new Error(SAFARI_SETUP);
      if (/already paired|another (WebDriver )?session/i.test(message)) throw new Error("Safari is already being automated by another session (one at a time). Close it and try again.");
      throw new Error(`Safari could not start an automation window: ${message}`);
    }
    this.session = json.value.sessionId;
    await this.call("POST", "/window/rect", { width: 1280, height: 860 }).catch(() => undefined);
    logger.info("browser", "Safari automation window started");
    this.sync();
  }

  async close(): Promise<void> {
    if (this.recording) await this.recordStop().catch(() => undefined);
    if (this.session) await this.call("DELETE", "").catch(() => undefined);
    this.session = undefined;
    this.driver?.kill();
    this.driver = undefined;
    this.current = { url: "about:blank", title: "" };
    this.sync();
  }

  private async execute<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.call<T>("POST", "/execute/sync", { script, args });
  }

  private async refresh(): Promise<void> {
    const url = await this.call<string>("GET", "/url").catch(() => this.current.url);
    const title = await this.call<string>("GET", "/title").catch(() => this.current.title);
    this.current = { url, title };
  }

  private async snapshotText(): Promise<string> {
    await this.refresh();
    return this.execute<string>(SNAPSHOT_SCRIPT, [SNAPSHOT_LIMIT]);
  }

  /** The element the agent means (a snapshot id or a CSS selector), scrolled into view, with its center. */
  private async target(args: Record<string, unknown>): Promise<{ element: string; x: number; y: number }> {
    let selector: string;
    if (args.id !== undefined) selector = `[data-saturn-ref="${Number(args.id)}"]`;
    else {
      selector = String(args.selector ?? "").trim();
      if (!selector) throw new Error("Give an element id from the snapshot, or a CSS selector.");
    }
    const found = await this.call<Record<string, string>>("POST", "/element", { using: "css selector", value: selector }).catch(() => undefined);
    const element = found?.[ELEMENT];
    if (!element) throw new Error(args.id !== undefined ? `No element [${String(args.id)}] in the last snapshot. Call browser_snapshot and use an id from it.` : `Nothing matches the selector ${selector}`);
    const center = await this.execute<{ x: number; y: number }>("const el = arguments[0]; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };", [{ [ELEMENT]: element }]);
    return { element, ...center };
  }

  /** The drawn cursor: injected again on each call, since WebDriver cannot add a script to every new page. */
  private async pointAt(x: number, y: number, click = false): Promise<void> {
    await this.execute(`${this.hooks.cursorScript}; window.__saturnCursor.move(arguments[0], arguments[1]);`, [Math.round(x), Math.round(y)]).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (click) {
      await this.execute("window.__saturnCursor && window.__saturnCursor.click(arguments[0], arguments[1]);", [Math.round(x), Math.round(y)]).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  async run(toolId: string, args: Record<string, unknown>): Promise<unknown> {
    if (toolId === "browser_close") {
      await this.close();
      return { closed: true };
    }
    await this.ensure();
    switch (toolId) {
      case "browser_navigate": {
        const raw = String(args.url ?? "");
        const url = PublicAddress.parse(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).url.toString();
        await this.call("POST", "/url", { url });
        const snapshot = await this.snapshotText();
        return { ...this.current, snapshot };
      }
      case "browser_snapshot":
        return { snapshot: await this.snapshotText() };
      case "browser_click": {
        const { element, x, y } = await this.target(args);
        await this.pointAt(x, y, true);
        await this.call("POST", `/element/${element}/click`, {});
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { clicked: true, snapshot: await this.snapshotText() };
      }
      case "browser_type": {
        const text = String(args.text ?? "");
        if (args.id !== undefined || args.selector) {
          const { element, x, y } = await this.target(args);
          await this.pointAt(x, y, true);
          if (args.clear !== false) await this.call("POST", `/element/${element}/clear`, {}).catch(() => undefined);
          await this.call("POST", `/element/${element}/value`, { text });
        } else {
          await this.keys([...text]);
        }
        if (args.submit) await this.keys([KEYS.enter!]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { typed: text.length, snapshot: await this.snapshotText() };
      }
      case "browser_press": {
        const key = String(args.key ?? "");
        const parts = key.split("+").map((part) => part.trim());
        const last = parts.pop() ?? "";
        const held = parts.map((part) => MODIFIERS[part.toLowerCase()]).filter((value): value is string => Boolean(value));
        await this.keys([KEYS[last.toLowerCase()] ?? last], held);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { pressed: key, snapshot: await this.snapshotText() };
      }
      case "browser_scroll": {
        const direction = ["up", "down", "left", "right"].includes(String(args.direction)) ? String(args.direction) : "down";
        const amount = Math.max(100, Math.min(5000, Number(args.pixels) || 600));
        await this.execute("window.scrollBy(arguments[0], arguments[1]);", [direction === "left" ? -amount : direction === "right" ? amount : 0, direction === "up" ? -amount : direction === "down" ? amount : 0]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { scrolled: direction, snapshot: await this.snapshotText() };
      }
      case "browser_screenshot": {
        const data = await this.call<string>("GET", "/screenshot");
        const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : undefined;
        if (file) {
          const target = path.resolve(this.dataDir, "workspace", file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(data, "base64"));
          return { file: target, bytes: Buffer.byteLength(data, "base64") };
        }
        return { image: `data:image/png;base64,${data}`, width: 1280, height: 800 };
      }
      case "browser_evaluate": {
        const expression = String(args.expression ?? "");
        if (!expression.trim()) throw new Error("Give a JavaScript expression");
        const result = await this.call<{ ok?: unknown; error?: string }>("POST", "/execute/async", {
          script: "const done = arguments[arguments.length - 1]; try { Promise.resolve((0, eval)(arguments[0])).then((value) => { try { done({ ok: JSON.parse(JSON.stringify(value === undefined ? null : value)) }); } catch { done({ ok: String(value) }); } }, (error) => done({ error: String(error && error.stack || error) })); } catch (error) { done({ error: String(error && error.stack || error) }); }",
          args: [expression],
        });
        if (result?.error) throw new Error(result.error);
        await this.refresh();
        return { value: result?.ok ?? null };
      }
      case "browser_record_start": {
        if (this.recording) throw new Error("Already recording; call browser_record_stop first.");
        const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().replace(/[^\w.-]/g, "_") : `recording-${Date.now().toString(36)}`;
        const folder = path.resolve(this.dataDir, "workspace", "recordings", name);
        await mkdir(folder, { recursive: true });
        this.recording = { file: folder, frames: 0, started: Date.now(), chunks: [] };
        this.sync();
        return { recording: folder, note: `Safari records a screenshot every ${FRAME_MS} ms; browser_record_stop writes frames.txt for ffmpeg (ffmpeg -f concat -i frames.txt out.mp4).` };
      }
      case "browser_record_stop":
        return this.recordStop();
      default:
        throw new Error(`Unknown browser tool: ${toolId}`);
    }
  }

  /** Key presses through WebDriver actions, with modifiers held around them. */
  private async keys(keys: string[], held: string[] = []): Promise<void> {
    const actions = [...held.map((value) => ({ type: "keyDown", value })), ...keys.flatMap((value) => [{ type: "keyDown", value }, { type: "keyUp", value }]), ...[...held].reverse().map((value) => ({ type: "keyUp", value }))];
    await this.call("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions }] });
    await this.call("DELETE", "/actions").catch(() => undefined);
  }

  private async recordStop() {
    const recording = this.recording;
    if (!recording) throw new Error("Not recording.");
    this.recording = undefined;
    this.sync();
    await writeFile(path.join(recording.file, "frames.txt"), recording.chunks.map((line) => `${line}\nduration ${FRAME_MS / 1000}`).join("\n") + "\n");
    return { recording: recording.file, frames: recording.frames, seconds: Math.round((Date.now() - recording.started) / 100) / 10 };
  }
}
