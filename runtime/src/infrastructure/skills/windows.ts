import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PermissionError, type AxNode, type MouseButton, type Permissions, type RunningApp } from "./macos.js";
import { WINDOWS_HELPER_SCRIPT, WINDOWS_HELPER_SOURCE } from "./windows-helper.js";

/** Windows asks for no permission; what blocks input is an app running as administrator (UIPI). */
export const ACCESSIBILITY_HELP =
  "Windows blocked input to this app. It is probably running as administrator, and Windows only lets Saturn control apps at Saturn's own privilege level. Run the app normally, or run Saturn as administrator.";
export const SCREEN_RECORDING_HELP = "Windows did not return a screenshot. Make sure the screen is on and not showing the lock screen or a UAC prompt.";
export const SCREEN_LOCKED_HELP = "The Windows screen is locked (or showing a secure desktop such as a UAC prompt), so nothing on it can be seen or controlled. Ask the user to unlock it, then try again.";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/**
 * One long-lived Windows PowerShell process running the compiled C# helper (windows-helper.ts). Starting PowerShell
 * and compiling costs about a second, so it happens once; requests then take milliseconds. Restarted if it exits.
 */
class Helper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  private files(): { script: string; source: string } {
    const hash = createHash("sha256").update(WINDOWS_HELPER_SOURCE).update(WINDOWS_HELPER_SCRIPT).digest("hex").slice(0, 12);
    const script = path.join(os.tmpdir(), `saturn-desktop-${hash}.ps1`);
    const source = path.join(os.tmpdir(), `saturn-desktop-${hash}.cs`);
    if (!existsSync(script)) writeFileSync(script, WINDOWS_HELPER_SCRIPT);
    if (!existsSync(source)) writeFileSync(source, WINDOWS_HELPER_SOURCE);
    return { script, source };
  }

  /**
   * Keeps Node's event loop alive only while a request is waiting: an idle helper (its process and pipes) must not
   * stop the runtime, or a test run, from exiting.
   */
  private hold(on: boolean): void {
    const child = this.child;
    if (!child) return;
    for (const handle of [child, child.stdin, child.stdout, child.stderr] as unknown as { ref?: () => void; unref?: () => void }[]) {
      if (on) handle.ref?.();
      else handle.unref?.();
    }
  }

  private start(): Promise<void> {
    const { script, source } = this.files();
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, source], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    return new Promise<void>((resolve, reject) => {
      const startup = setTimeout(() => reject(new Error(`The Windows desktop helper did not start: ${stderr.trim() || "no answer"}`)), 30_000);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; error?: string };
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.ready) {
          clearTimeout(startup);
          if (!this.pending.size) this.hold(false);
          resolve();
          return;
        }
        const waiting = message.id === undefined ? undefined : this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id!);
        clearTimeout(waiting.timer);
        if (!this.pending.size) this.hold(false);
        if (message.ok) waiting.resolve(message.result);
        else waiting.reject(explain(message.error ?? "The Windows action failed"));
      });
      child.on("error", (error) => {
        clearTimeout(startup);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(startup);
        this.child = null;
        this.ready = null;
        const reason = new Error(`The Windows desktop helper stopped (${code ?? "signal"}): ${stderr.trim().slice(-500)}`);
        for (const [, waiting] of this.pending) {
          clearTimeout(waiting.timer);
          waiting.reject(reason);
        }
        this.pending.clear();
        reject(reason);
      });
    });
  }

  async call<T>(op: string, args: Record<string, unknown> = {}, timeout = 20_000): Promise<T> {
    if (!this.ready || !this.child) this.ready = this.start();
    await this.ready;
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!this.pending.size) this.hold(false);
        reject(new Error("Windows did not answer in time; the app may be busy. Try again."));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.hold(true);
      this.child!.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }
}

const helper = new Helper();

/** Windows errors in the user's terms. */
export function explain(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/administrator|access is denied|UIPI/i.test(text)) return new PermissionError(ACCESSIBILITY_HELP);
  return new Error(text || "The Windows action failed");
}

/** Windows grants desktop control to every app at the same privilege level, so there is nothing to ask for. */
export async function permissions(): Promise<Permissions> {
  return { accessibility: true, screenRecording: true };
}

export async function screenLocked(): Promise<boolean> {
  return await helper.call<boolean>("locked");
}

export async function displaySize(): Promise<{ width: number; height: number }> {
  return await helper.call("display");
}

export async function capture(region: { x: number; y: number; width: number; height: number } | null, canvas: { width: number; height: number }): Promise<string> {
  const area = region ?? { x: 0, y: 0, ...(await displaySize()) };
  try {
    const base64 = await helper.call<string>("capture", { x: Math.round(area.x), y: Math.round(area.y), width: Math.round(area.width), height: Math.round(area.height), canvasWidth: canvas.width, canvasHeight: canvas.height }, 30_000);
    if (!base64 || base64.length < 1000) throw new Error("Windows returned an empty screenshot");
    return `data:image/jpeg;base64,${base64}`;
  } catch (error) {
    throw new Error(`Could not take a screenshot: ${(error as Error).message}`);
  }
}

export async function runningApps(): Promise<RunningApp[]> {
  const apps = (await helper.call<RunningApp[] | null>("apps")) ?? [];
  return apps.sort((a, b) => Number(b.frontmost) - Number(a.frontmost) || a.name.localeCompare(b.name));
}

/** Starts an app by executable path or name (anything the Run dialog understands: "notepad", "calc", a full path). */
export async function launchApp(selector: { bundleId?: string; appPath?: string; appName?: string }): Promise<void> {
  const target = selector.appPath || selector.bundleId || selector.appName || "";
  try {
    await helper.call("launch", { target });
  } catch (error) {
    throw new Error(`Could not open ${target}: ${(error as Error).message}`);
  }
}

export async function activate(pid: number): Promise<void> {
  await helper.call("activate", { pid });
}

export async function windowFrame(pid: number): Promise<{ x: number; y: number; width: number; height: number }> {
  return await helper.call("frame", { pid });
}

export async function mouse(input: { kind: "click" | "move" | "drag"; x: number; y: number; to?: { x: number; y: number }; button?: MouseButton; count?: number }): Promise<void> {
  await helper.call("mouse", { kind: input.kind, x: input.x, y: input.y, toX: input.to?.x ?? input.x, toY: input.to?.y ?? input.y, button: input.button ?? "left", count: input.count ?? 1 });
}

/** Wheel ticks at a screen point, with the same signs as on macOS: positive `dy` scrolls up, positive `dx` left. */
export async function scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
  await helper.call("scroll", { x, y, dx, dy });
}

/** Windows virtual-key codes for named keys; "extended" keys need the extended-key flag to reach the right key. */
const KEYS: Record<string, { vk: number; extended?: boolean }> = {
  return: { vk: 0x0d }, enter: { vk: 0x0d }, tab: { vk: 0x09 }, space: { vk: 0x20 }, backspace: { vk: 0x08 },
  delete: { vk: 0x2e, extended: true }, forwarddelete: { vk: 0x2e, extended: true }, escape: { vk: 0x1b }, esc: { vk: 0x1b },
  insert: { vk: 0x2d, extended: true }, home: { vk: 0x24, extended: true }, end: { vk: 0x23, extended: true },
  pageup: { vk: 0x21, extended: true }, pagedown: { vk: 0x22, extended: true },
  left: { vk: 0x25, extended: true }, up: { vk: 0x26, extended: true }, right: { vk: 0x27, extended: true }, down: { vk: 0x28, extended: true },
  arrowleft: { vk: 0x25, extended: true }, arrowup: { vk: 0x26, extended: true }, arrowright: { vk: 0x27, extended: true }, arrowdown: { vk: 0x28, extended: true },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, { vk: 0x70 + i }])),
};
/** cmd and command mean Ctrl here, so shortcuts written the macOS way ("cmd+c") still work; win/super is the Windows key. */
const MODIFIERS: Record<string, number> = {
  ctrl: 0x11, control: 0x11, cmd: 0x11, command: 0x11, alt: 0x12, option: 0x12, opt: 0x12, shift: 0x10, win: 0x5b, super: 0x5b, meta: 0x5b,
};

export function parseChord(chord: string): { modifiers: number[]; vk: number; char: string; extended: boolean } {
  const parts = chord.split("+").map((part) => part.trim()).filter(Boolean);
  const last = parts.pop();
  if (!last) throw new Error("No key given");
  const modifiers = parts.map((part) => {
    const code = MODIFIERS[part.toLowerCase()];
    if (code === undefined) throw new Error(`Unknown modifier "${part}". Use ctrl, alt, shift or win.`);
    return code;
  });
  const named = KEYS[last.toLowerCase()];
  if (named) return { modifiers, vk: named.vk, char: "", extended: Boolean(named.extended) };
  if ([...last].length !== 1) throw new Error(`Unknown key "${last}". Use a single character or a name like Return, Tab, Escape, Up or F5.`);
  // With a modifier, a letter is the key itself (ctrl+a, not ctrl+shift+a for "A").
  return { modifiers, vk: 0, char: modifiers.length ? last.toLowerCase() : last, extended: false };
}

export async function key(chord: string): Promise<void> {
  await helper.call("key", parseChord(chord));
}

/** Types text into the focused field as Unicode input, so any language works and the clipboard is never touched. */
export async function typeText(text: string): Promise<void> {
  await helper.call("type", { text }, 60_000);
}

export async function accessibilityTree(pid: number, options: { root?: number[]; limit?: number; depth?: number } = {}): Promise<AxNode[]> {
  return (await helper.call<AxNode[] | null>("tree", { pid, root: options.root ?? [], limit: options.limit ?? 250, depth: options.depth ?? 12 }, 60_000)) ?? [];
}

export async function accessibilityAction(pid: number, elementPath: number[], action: string): Promise<void> {
  await helper.call("action", { pid, path: elementPath, action });
}

export async function accessibilitySetValue(pid: number, elementPath: number[], value: string, focusOnly = false): Promise<void> {
  await helper.call("setValue", { pid, path: elementPath, value, focusOnly });
}
