import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { launchEnv } from "../launch-env.js";

const execFileAsync = promisify(execFile);

/** What the user has to do when macOS refuses input or the accessibility tree. */
export const ACCESSIBILITY_HELP =
  "Saturn needs the Accessibility permission to control apps. Open System Settings → Privacy & Security → Accessibility and turn on Saturn. " +
  "If Saturn is already on but this keeps happening, remove it with the − button and add it again: each Saturn update is a new app to macOS.";
/** What the user has to do when macOS refuses screenshots. */
export const SCREEN_RECORDING_HELP =
  "Saturn needs the Screen Recording permission to take screenshots. Open System Settings → Privacy & Security → Screen & System Audio Recording and turn on Saturn, then restart Saturn. " +
  "If it is already on, remove it with the − button and add it again: each Saturn update is a new app to macOS.";

/** A refusal the user can fix in System Settings; its message says how. */
export class PermissionError extends Error {}

/**
 * Runs a JXA (JavaScript for Automation) script. Its `run(argv)` receives `params` as JSON in argv[0], so no value is
 * ever spliced into the script text, and whatever it returns comes back parsed from JSON.
 */
export async function jxa<T>(script: string, params: unknown = {}, timeout = 15_000): Promise<T> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(params)], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: launchEnv(),
    });
    const text = stdout.trim();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (error) {
    throw explain(error);
  }
}

/** macOS errors in the user's terms: a missing permission says where to grant it; anything else keeps its message. */
export function explain(error: unknown): Error {
  const failed = error as { stderr?: string; message?: string; killed?: boolean };
  const text = `${failed.stderr ?? ""} ${failed.message ?? ""}`;
  if (/-25211|-1719|assistive access|not allowed assistive|not trusted/i.test(text)) return new PermissionError(ACCESSIBILITY_HELP);
  if (/-1743|not authorized to send apple events|not allowed to send/i.test(text)) {
    return new PermissionError("Saturn is not allowed to control System Events. Open System Settings → Privacy & Security → Automation and allow Saturn to control System Events.");
  }
  if (failed.killed) return new Error("macOS did not answer in time; the app may be busy. Try again.");
  // osascript prints "execution error: Error: <message> (-2700)"; keep only the message.
  const detail = (failed.stderr || failed.message || String(error))
    .replace(/^.*execution error:\s*/s, "")
    .replace(/^(Error:\s*)+/, "")
    .replace(/\s*\(-?\d+\)\s*$/, "")
    .trim();
  return new Error(detail || "The macOS action failed");
}

export type Permissions = { accessibility: boolean; screenRecording: boolean };

/** Asks macOS itself (AXIsProcessTrusted, CGPreflightScreenCaptureAccess) for the permissions Saturn holds. */
export async function permissions(): Promise<Permissions> {
  return await jxa<Permissions>(`function run() {
    ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
    // Not in JXA's CoreGraphics bridge (macOS 10.15+), so it is declared here.
    ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
    return JSON.stringify({ accessibility: !!$.AXIsProcessTrusted(), screenRecording: !!$.CGPreflightScreenCaptureAccess() });
  }`);
}

/** True while the Mac shows its lock screen: nothing can be seen or clicked until the user unlocks it. */
export async function screenLocked(): Promise<boolean> {
  return await jxa<boolean>(`function run() {
    ObjC.import('CoreGraphics');
    const session = ObjC.castRefToObject($.CGSessionCopyCurrentDictionary());
    const locked = session.objectForKey('CGSSessionScreenIsLocked');
    return JSON.stringify(!!(locked && !locked.isNil() && locked.boolValue));
  }`);
}

/** What the agent tells the user when the screen is locked. */
export const SCREEN_LOCKED_HELP = "The Mac's screen is locked, so nothing on it can be seen or controlled. Ask the user to unlock it, then try again.";

/** The main display's size in points (the coordinate space mouse events use). */
export async function displaySize(): Promise<{ width: number; height: number }> {
  return await jxa(`function run() {
    ObjC.import('CoreGraphics');
    const b = $.CGDisplayBounds($.CGMainDisplayID());
    return JSON.stringify({ width: Math.round(b.size.width), height: Math.round(b.size.height) });
  }`);
}

export type MouseButton = "left" | "right" | "middle";

/**
 * Real mouse input through CoreGraphics events, in screen points. Without the Accessibility permission macOS drops
 * these events silently, so callers check `permissions()` first.
 */
export async function mouse(input: {
  kind: "click" | "move" | "drag";
  x: number;
  y: number;
  to?: { x: number; y: number };
  button?: MouseButton;
  count?: number;
}): Promise<void> {
  await jxa(`function run(argv) {
    ObjC.import('CoreGraphics');
    const p = JSON.parse(argv[0]);
    // CGEventType and CGMouseButton values (CGEventTypes.h).
    const kinds = { left: [1, 2, 6, 0], right: [3, 4, 7, 1], middle: [25, 26, 27, 2] }[p.button || 'left'];
    const post = (type, x, y, clicks) => {
      const e = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), kinds[3]);
      if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks); // kCGMouseEventClickState
      $.CGEventPost(0, e); // kCGHIDEventTap
    };
    const pause = (s) => delay(s);
    post(5, p.x, p.y, 0); // move there first, so hover state and the click target agree
    if (p.kind === 'move') return 'null';
    if (p.kind === 'click') {
      const count = Math.max(1, Math.min(3, p.count || 1));
      for (let i = 1; i <= count; i++) { post(kinds[0], p.x, p.y, i); post(kinds[1], p.x, p.y, i); if (i < count) pause(0.05); }
      return 'null';
    }
    post(kinds[0], p.x, p.y, 1);
    const steps = 12;
    for (let i = 1; i <= steps; i++) { pause(0.015); post(kinds[2], p.x + (p.to.x - p.x) * i / steps, p.y + (p.to.y - p.y) * i / steps, 1); }
    post(kinds[1], p.to.x, p.to.y, 1);
    return 'null';
  }`, input);
}

/** Scroll wheel ticks at a screen point: positive `dy` scrolls content up (wheel away), as on a mouse. */
export async function scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
  await jxa(`function run(argv) {
    ObjC.import('CoreGraphics');
    const p = JSON.parse(argv[0]);
    $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 5, $.CGPointMake(p.x, p.y), 0));
    for (let i = 0; i < Math.max(Math.abs(p.dy), Math.abs(p.dx)); i++) {
      const e = $.CGEventCreateScrollWheelEvent2($(), 1, 2, i < Math.abs(p.dy) ? Math.sign(p.dy) : 0, i < Math.abs(p.dx) ? Math.sign(p.dx) : 0, 0);
      $.CGEventPost(0, e);
      delay(0.02);
    }
    return 'null';
  }`, { x, y, dx, dy });
}

/** macOS virtual key codes for named keys (Events.h); letters and digits go through System Events keystrokes. */
const KEY_CODES: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126, arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MODIFIERS: Record<string, string> = {
  cmd: "command down", command: "command down", meta: "command down", super: "command down",
  ctrl: "control down", control: "control down", alt: "option down", option: "option down", opt: "option down", shift: "shift down",
};

/** "cmd+shift+s" → the key and the System Events modifiers it needs; throws on a name it does not know. */
export function parseChord(chord: string): { key: string; code?: number; modifiers: string[] } {
  const parts = chord.split("+").map((part) => part.trim()).filter(Boolean);
  const last = parts.pop();
  if (!last) throw new Error("No key given");
  const modifiers = parts.map((part) => {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) throw new Error(`Unknown modifier "${part}". Use cmd, ctrl, alt or shift.`);
    return modifier;
  });
  const named = KEY_CODES[last.toLowerCase()];
  if (named !== undefined) return { key: last, code: named, modifiers };
  if ([...last].length !== 1) throw new Error(`Unknown key "${last}". Use a single character or a name like Return, Tab, Escape, Up or F5.`);
  return { key: last.toLowerCase(), modifiers };
}

/** Presses a key or chord in the frontmost app. */
export async function key(chord: string): Promise<void> {
  const parsed = parseChord(chord);
  await jxa(`function run(argv) {
    const p = JSON.parse(argv[0]);
    const se = Application('System Events');
    const using = p.modifiers.length ? { using: p.modifiers } : {};
    if (p.code !== undefined) se.keyCode(p.code, using); else se.keystroke(p.key, using);
    return 'null';
  }`, parsed);
}

/**
 * Types text into the focused field of the frontmost app. Plain ASCII is typed as keystrokes; anything else (Chinese,
 * emoji…) is pasted, and the clipboard is put back afterwards.
 */
export async function typeText(text: string): Promise<void> {
  await jxa(`function run(argv) {
    const p = JSON.parse(argv[0]);
    const se = Application('System Events');
    if (/^[\\x20-\\x7e\\n\\t]*$/.test(p.text)) {
      const lines = p.text.split('\\n');
      lines.forEach((line, i) => { if (line) se.keystroke(line); if (i < lines.length - 1) se.keyCode(36); });
      return 'null';
    }
    const app = Application.currentApplication(); app.includeStandardAdditions = true;
    let saved = null; try { saved = app.theClipboard(); } catch (e) {}
    app.setTheClipboardTo(p.text);
    se.keystroke('v', { using: ['command down'] });
    delay(0.25);
    if (saved !== null) { try { app.setTheClipboardTo(saved); } catch (e) {} }
    return 'null';
  }`, { text });
}

export type RunningApp = { name: string; pid: number; bundle_id: string; frontmost: boolean; process?: string; window_title?: string };

/** Regular running apps (those with a Dock icon), frontmost first. Needs no permission. */
export async function runningApps(): Promise<RunningApp[]> {
  const apps = await jxa<RunningApp[]>(`function run() {
    ObjC.import('AppKit');
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    const frontPid = front ? front.processIdentifier : -1;
    const list = $.NSWorkspace.sharedWorkspace.runningApplications;
    const out = [];
    // The bridge hands NSInteger properties back as strings, hence Number().
    for (let i = 0; i < Number(list.count); i++) {
      const a = list.objectAtIndex(i);
      if (Number(a.activationPolicy) !== 0) continue; // NSApplicationActivationPolicyRegular
      out.push({ name: ObjC.unwrap(a.localizedName) || '', pid: Number(a.processIdentifier), bundle_id: ObjC.unwrap(a.bundleIdentifier) || '', frontmost: Number(a.processIdentifier) === Number(frontPid) });
    }
    return JSON.stringify(out);
  }`);
  return apps.sort((a, b) => Number(b.frontmost) - Number(a.frontmost));
}

/** Brings an app's windows forward, so input lands in it. */
export async function activate(pid: number): Promise<void> {
  await jxa(`function run(argv) {
    ObjC.import('AppKit');
    const p = JSON.parse(argv[0]);
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(p.pid);
    if (!app || app.isNil()) throw new Error('No running app with pid ' + p.pid);
    app.activateWithOptions(2); // NSApplicationActivateIgnoringOtherApps
    delay(0.3);
    return 'null';
  }`, { pid });
}

/** The front window's frame in screen points, through accessibility. */
export async function windowFrame(pid: number): Promise<{ x: number; y: number; width: number; height: number }> {
  return await jxa(`function run(argv) {
    const p = JSON.parse(argv[0]);
    const proc = Application('System Events').processes.whose({ unixId: p.pid })[0];
    const windows = proc.windows();
    if (!windows.length) throw new Error('The app has no open window');
    const position = windows[0].position(), size = windows[0].size();
    return JSON.stringify({ x: position[0], y: position[1], width: size[0], height: size[1] });
  }`, { pid });
}

export type AxNode = { path: number[]; depth: number; role: string; name: string; value: string; actions: string[]; settable: boolean; omitted: number };

/**
 * Reads an app's front-window accessibility tree breadth-first, a level at a time with bulk queries (one Apple
 * event per property per parent, not per element), up to `limit` elements. `root` starts below an element instead.
 *
 * A big web page can hold thousands of elements in one container, and asking for all their properties at once can
 * take System Events longer than any timeout. So the walk has a time budget and returns what it read so far
 * (`truncated`), and a container with more than `wide` children is not read in bulk: the element shows how many it
 * holds and can be expanded on its own, which reads its first `wide` children one by one.
 */
export async function accessibilityTree(pid: number, options: { root?: number[]; limit?: number; depth?: number; budgetMs?: number; wide?: number } = {}): Promise<AxNode[] & { truncated?: boolean }> {
  const budgetMs = options.budgetMs ?? 18_000;
  const result = await jxa<{ nodes: AxNode[]; truncated: boolean }>(`function run(argv) {
    const p = JSON.parse(argv[0]);
    const started = Date.now();
    const late = () => Date.now() - started > p.budget;
    const proc = Application('System Events').processes.whose({ unixId: p.pid })[0];
    if (!proc.windows().length) throw new Error('The app has no open window');
    let root = proc.windows[0];
    for (const i of p.root) root = root.uiElements[i];
    const settableRoles = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXSecureTextField', 'AXSlider', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton'];
    const safe = (f, fallback) => { try { const v = f(); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; } };
    const text = (v) => typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : '';
    const out = [];
    let truncated = false;
    const add = (parent, i, role, name, title, desc, value, actions) => {
      const node = { path: parent.path.concat([i]), depth: parent.depth + 1, role: role || 'AXUnknown',
        name: text(name) || text(title) || text(desc), value: text(value).slice(0, 200),
        actions: (actions || []).filter((a) => a !== 'AXPress' && a !== 'AXShowDefaultUI'),
        settable: settableRoles.indexOf(role) >= 0, omitted: 0 };
      out.push(node);
      return node;
    };
    let level = [{ el: root, path: p.root, depth: 0, node: null }];
    while (level.length && out.length < p.limit && !truncated) {
      const next = [];
      for (const parent of level) {
        if (out.length >= p.limit || parent.depth >= p.depth) break;
        if (late()) { truncated = true; break; }
        const kids = parent.el.uiElements;
        const count = safe(() => kids.length, 0);
        if (!count) continue;
        if (count > p.wide) {
          if (parent.node) { parent.node.omitted += count; continue; }
          // The element being expanded is itself huge: its first children, one at a time, within the budget.
          for (let i = 0; i < Math.min(count, p.wide); i++) {
            if (out.length >= p.limit || late()) { truncated = true; break; }
            const kid = kids[i];
            const node = add(parent, i, safe(() => kid.role(), ''), safe(() => kid.name(), ''), safe(() => kid.title(), ''), safe(() => kid.description(), ''), safe(() => kid.value(), ''), safe(() => kid.actions.name(), []));
            next.push({ el: kid, path: node.path, depth: node.depth, node });
          }
          if (out.length) out[out.length - 1].omitted += Math.max(0, count - p.wide);
          continue;
        }
        const roles = safe(() => kids.role(), []);
        if (!roles.length) continue;
        const names = safe(() => kids.name(), []), descs = safe(() => kids.description(), []), titles = safe(() => kids.title(), []);
        const values = safe(() => kids.value(), []), actions = safe(() => kids.actions.name(), []);
        for (let i = 0; i < roles.length; i++) {
          if (out.length >= p.limit) { out[out.length - 1].omitted += roles.length - i; break; }
          const node = add(parent, i, roles[i], names[i], titles[i], descs[i], values[i], actions[i]);
          next.push({ el: kids[i], path: node.path, depth: node.depth, node });
        }
      }
      level = next;
    }
    return JSON.stringify({ nodes: out, truncated });
  }`, { pid, root: options.root ?? [], limit: options.limit ?? 250, depth: options.depth ?? 12, budget: budgetMs, wide: options.wide ?? 150 }, budgetMs + 15_000);
  return Object.assign(result.nodes, { truncated: result.truncated });
}

/** Performs an accessibility action ("AXPress", "AXShowMenu"…) on the element at `path` in the front window. */
export async function accessibilityAction(pid: number, path: number[], action: string): Promise<void> {
  await jxa(`function run(argv) {
    const p = JSON.parse(argv[0]);
    let el = Application('System Events').processes.whose({ unixId: p.pid })[0].windows[0];
    for (const i of p.path) el = el.uiElements[i];
    el.actions.byName(p.action).perform();
    return 'null';
  }`, { pid, path, action });
}

/** Sets the value of the element at `path` in the front window, focusing it first. */
export async function accessibilitySetValue(pid: number, path: number[], value: string, focusOnly = false): Promise<void> {
  await jxa(`function run(argv) {
    const p = JSON.parse(argv[0]);
    let el = Application('System Events').processes.whose({ unixId: p.pid })[0].windows[0];
    for (const i of p.path) el = el.uiElements[i];
    try { el.focused = true; } catch (e) {}
    if (!p.focusOnly) el.value = p.value;
    return 'null';
  }`, { pid, path, value, focusOnly });
}

/**
 * A screenshot of the display (or of `region`, in points) stretched to `canvas`, as a JPEG data URL.
 * Throws instead of returning a blank image when macOS refuses it.
 */
export async function capture(region: { x: number; y: number; width: number; height: number } | null, canvas: { width: number; height: number }): Promise<string> {
  const raw = path.join(os.tmpdir(), `saturn-shot-${process.pid}-${Date.now()}.png`);
  const jpeg = raw.replace(/\.png$/, ".jpg");
  try {
    const where = region ? ["-R", `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}`] : ["-m"];
    await execFileAsync("/usr/sbin/screencapture", ["-x", "-C", "-t", "png", ...where, raw], { env: launchEnv(), timeout: 15_000 });
    await execFileAsync("/usr/bin/sips", ["-z", String(canvas.height), String(canvas.width), "-s", "format", "jpeg", "-s", "formatOptions", "70", raw, "--out", jpeg], { env: launchEnv(), timeout: 15_000 });
    const buffer = await fs.readFile(jpeg);
    if (buffer.length < 1000) throw new Error("macOS returned an empty screenshot");
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch (error) {
    const reason = explain(error);
    throw reason instanceof PermissionError ? reason : new Error(`Could not take a screenshot: ${reason.message}`);
  } finally {
    await fs.rm(raw, { force: true });
    await fs.rm(jpeg, { force: true });
  }
}

/** Opens an app in the background (`open -g`) by bundle id, .app path or name. */
export async function launchApp(selector: { bundleId?: string; appPath?: string; appName?: string }): Promise<void> {
  const how = selector.bundleId ? ["-g", "-b", selector.bundleId] : selector.appPath ? ["-g", selector.appPath] : ["-g", "-a", selector.appName ?? ""];
  try {
    await execFileAsync("open", how, { env: launchEnv(), timeout: 15_000 });
  } catch (error) {
    throw new Error(`Could not open ${selector.bundleId || selector.appPath || selector.appName}: ${explain(error).message}`);
  }
}
