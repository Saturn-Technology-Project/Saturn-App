import path from "node:path";
import * as macos from "./macos.js";
import { PermissionError, type AxNode, type MouseButton } from "./macos.js";
import * as windows from "./windows.js";

/** The desktop primitives for this platform: macOS (JXA, CoreGraphics, accessibility) or Windows (SendInput, UI Automation). */
const desktop = process.platform === "win32" ? windows : macos;
const { ACCESSIBILITY_HELP, SCREEN_LOCKED_HELP, SCREEN_RECORDING_HELP } = desktop;
const SUPPORTED = process.platform === "darwin" || process.platform === "win32";

/** Every coordinate the model sends or sees is a pixel in this canvas (see the tool definitions in cursor-tools.ts). */
export const CANVAS = { width: 1280, height: 800 } as const;
/** Elements read per accessibility snapshot, so a large window does not flood the model's context. */
const TREE_LIMIT = 250;
/** Tools that do not look at or touch the screen, and so work while it is locked. */
const PASSIVE_TOOLS = new Set(["computer_check_permissions", "computer_apps", "computer_resolve_app", "computer_wait", "computer_start_control", "computer_release_control"]);
/** How long a permission check is trusted before asking macOS again. */
const PERMISSION_TTL_MS = 15_000;

export interface ComputerTarget {
  scope?: "app" | "screen";
  pid?: number;
  target_id?: string;
  bundle_id?: string;
}

/** The screen region a screenshot showed, in screen points: canvas pixels map onto it. */
export type Region = { x: number; y: number; width: number; height: number };

/** A canvas pixel → the screen point it shows, for a screenshot of `region` stretched to the canvas. */
export function toScreen(region: Region, x: number, y: number): { x: number; y: number } {
  const cx = Math.min(Math.max(x, 0), CANVAS.width - 1);
  const cy = Math.min(Math.max(y, 0), CANVAS.height - 1);
  return { x: Math.round(region.x + (cx * region.width) / CANVAS.width), y: Math.round(region.y + (cy * region.height) / CANVAS.height) };
}

/** An app screenshot's window region, handed to the model as an opaque token and checked on the way back. */
export function encodeToken(pid: number, region: Region): string {
  return Buffer.from(JSON.stringify({ pid, ...region })).toString("base64url");
}

export function decodeToken(token: string, pid: number): Region {
  let parsed: Partial<Region & { pid: number }>;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<Region & { pid: number }>;
  } catch {
    throw new Error("coordinate_token is not valid. Take a new computer_screenshot of this app and use its coordinate_token.");
  }
  if (parsed.pid !== pid || [parsed.x, parsed.y, parsed.width, parsed.height].some((value) => typeof value !== "number")) {
    throw new Error("coordinate_token belongs to another app or screenshot. Take a new computer_screenshot of this app.");
  }
  return { x: parsed.x!, y: parsed.y!, width: parsed.width!, height: parsed.height! };
}

/** Accessibility tree lines in the format the tool definition promises: "[id] ROLE name=… value=… settable actions=…". */
export function formatTree(nodes: (AxNode & { id: number })[], snapshotId: string): string {
  const lines = nodes.map((node) => {
    const parts = [`[${node.id}] ${node.role.replace(/^AX/, "")}`];
    if (node.name) parts.push(`name=${JSON.stringify(node.name)}`);
    if (node.value) parts.push(`value=${JSON.stringify(node.value)}`);
    if (node.settable) parts.push("settable");
    if (node.actions.length) parts.push(`actions=${node.actions.map(actionName).join(",")}`);
    if (node.omitted) parts.push(`(+${node.omitted} descendants omitted)`);
    return `${"  ".repeat(Math.max(0, node.depth - 1))}${parts.join(" ")}`;
  });
  return [...lines, `snapshot_id=${snapshotId}`].join("\n");
}

/** AXShowMenu → show-menu (how actions are listed); show-menu, ShowMenu or AXShowMenu → AXShowMenu (how they run). */
export function actionName(ax: string): string {
  return ax.replace(/^AX/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

export function axAction(name: string): string {
  if (!name || name === "press") return "AXPress";
  if (name.startsWith("AX")) return name;
  return `AX${name.split(/[-_\s]+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}`;
}

type Snapshot = { pid: number; elements: Map<number, number[]>; nextId: number };

/**
 * The computer-use tools on macOS and Windows: real screenshots, real mouse and keyboard input, and the app's element
 * tree (macOS accessibility, Windows UI Automation). Every action either happens or throws a reason (a missing
 * permission says what to turn on); nothing reports success it did not have.
 */
export class ComputerUseSkill {
  private displayControlled = false;
  private permissionsCheckedAt = 0;
  private granted: { accessibility: boolean; screenRecording: boolean } | null = null;
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly dataDir: string) {}

  async run(toolId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (!SUPPORTED && toolId !== "computer_wait") {
      throw new Error("Computer use is available on macOS and Windows.");
    }
    // On the lock screen every screenshot is the wallpaper and every click is lost, so say so instead.
    if (!PASSIVE_TOOLS.has(toolId) && (await desktop.screenLocked())) throw new Error(SCREEN_LOCKED_HELP);
    switch (toolId) {
      case "computer_check_permissions":
        return this.checkPermissions();
      case "computer_apps":
        return this.listApps();
      case "computer_resolve_app":
        return this.resolveApp(args);
      case "computer_screenshot":
        return this.takeScreenshot(args);
      case "computer_click":
        return this.click(args);
      case "computer_move":
        return this.move(args);
      case "computer_drag":
        return this.drag(args);
      case "computer_type":
        return this.typeText(args);
      case "computer_key":
        return this.pressKey(args);
      case "computer_scroll":
        return this.scroll(args);
      case "computer_wait":
        return this.wait(args, signal);
      case "computer_start_control":
        this.displayControlled = true;
        return { active: true, display: "primary", message: "Display control acquired" };
      case "computer_release_control":
        this.displayControlled = false;
        return { active: false, message: "Display control released" };
      case "computer_app_state":
        return this.appState(args);
      case "computer_set_value":
        return this.setValue(args);
      case "computer_app_action":
        return this.appAction(args);
      default:
        throw new Error(`Unknown computer use tool: ${toolId}`);
    }
  }

  private async checkPermissions() {
    const granted = await this.permissions(true);
    const locked = await desktop.screenLocked();
    const canvas = { width: CANVAS.width, height: CANVAS.height };
    const status = !granted.accessibility ? "requires_accessibility_permission" : !granted.screenRecording ? "requires_screen_recording_permission" : "ready";
    return {
      ...granted,
      screenLocked: locked,
      displayAttached: true,
      canvas,
      status: status === "ready" && locked ? "screen_locked" : status,
      ...(status === "ready" ? {} : { help: !granted.accessibility ? ACCESSIBILITY_HELP : SCREEN_RECORDING_HELP }),
    };
  }

  private async permissions(fresh = false) {
    if (!fresh && this.granted && Date.now() - this.permissionsCheckedAt < PERMISSION_TTL_MS) return this.granted;
    this.granted = await desktop.permissions();
    this.permissionsCheckedAt = Date.now();
    return this.granted;
  }

  /** Input and the accessibility tree are dropped silently by macOS without this permission, so it is checked first. */
  private async requireAccessibility(): Promise<void> {
    if (!(await this.permissions()).accessibility) {
      this.granted = null;
      throw new PermissionError(ACCESSIBILITY_HELP);
    }
  }

  private async requireScreenRecording(): Promise<void> {
    if (!(await this.permissions()).screenRecording) {
      this.granted = null;
      throw new PermissionError(SCREEN_RECORDING_HELP);
    }
  }

  private async listApps() {
    const apps = await desktop.runningApps();
    return { apps: apps.map((app) => ({ ...app, target_id: `app_${app.pid}` })), count: apps.length };
  }

  /** Finds an app by exactly one selector, launching it (in the background on macOS) when it is not running. */
  private async resolveApp(args: Record<string, unknown>) {
    const pid = typeof args.pid === "number" ? args.pid : 0;
    const bundleId = text(args.bundle_id);
    const appPath = text(args.app_path);
    const appName = text(args.app_name) || text(args.name);
    if ([pid, bundleId, appPath, appName].filter(Boolean).length !== 1) {
      throw new Error("Give exactly one of pid, bundle_id, app_path or app_name.");
    }
    const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
    const stem = (file: string) => path.basename(file.replace(/\\/g, "/")).replace(/\.(app|exe)$/i, "");
    const match = (app: { pid: number; bundle_id: string; name: string; process?: string }) =>
      (pid && app.pid === pid) ||
      (bundleId && same(app.bundle_id, bundleId)) ||
      (appName && (same(app.name, appName) || same(app.process, stem(appName)))) ||
      (appPath && (same(app.bundle_id, appPath) || same(app.name, stem(appPath)) || same(app.process, stem(appPath))));
    let found = (await desktop.runningApps()).find(match);
    if (!found && !pid) {
      await desktop.launchApp({ bundleId, appPath, appName });
      for (let attempt = 0; attempt < 20 && !found; attempt += 1) {
        await sleep(250);
        found = (await desktop.runningApps()).find(match);
      }
    }
    if (!found) throw new Error(`No running app matches ${pid ? `pid ${pid}` : bundleId || appPath || appName}.`);
    return { resolved: true, name: found.name, pid: found.pid, bundle_id: found.bundle_id, target_id: `app_${found.pid}` };
  }

  /** The app a target names, or null for the whole screen. */
  private appTarget(args: Record<string, unknown>): number | null {
    const target = (args.target ?? {}) as ComputerTarget;
    if (target.scope === "screen") return null;
    const pid = typeof target.pid === "number" ? target.pid : Number(String(target.target_id ?? "").replace(/^app_/, "")) || 0;
    if (target.scope === "app" && !pid) throw new Error("An app target needs the pid or target_id from computer_apps or computer_resolve_app.");
    return pid || null;
  }

  /** The screen region canvas coordinates refer to: the whole display, or the app window its token recorded. */
  private async regionFor(args: Record<string, unknown>): Promise<{ region: Region; pid: number | null }> {
    const pid = this.appTarget(args);
    if (pid === null) {
      const display = await desktop.displaySize();
      return { region: { x: 0, y: 0, ...display }, pid: null };
    }
    const token = text(args.coordinate_token);
    if (!token) throw new Error("With an app target, pass the coordinate_token from the latest computer_screenshot of this app.");
    return { region: decodeToken(token, pid), pid };
  }

  private async takeScreenshot(args: Record<string, unknown>) {
    await this.requireScreenRecording();
    const pid = this.appTarget(args);
    let region: Region;
    if (pid === null) {
      region = { x: 0, y: 0, ...(await desktop.displaySize()) };
    } else {
      await this.requireAccessibility();
      region = await desktop.windowFrame(pid);
    }
    const image = await desktop.capture(pid === null ? null : region, CANVAS);
    return {
      image,
      width: CANVAS.width,
      height: CANVAS.height,
      scope: pid === null ? "screen" : "app",
      region,
      ...(pid === null ? {} : { pid, coordinate_token: encodeToken(pid, region) }),
      timestamp: new Date().toISOString(),
    };
  }

  /** After a screen-scope action, a fresh screenshot so the model sees what changed (app-scope results are text). */
  private async after(action: Record<string, unknown>, pid: number | null) {
    if (pid !== null) return action;
    await sleep(350);
    try {
      return { ...action, image: await desktop.capture(null, CANVAS), width: CANVAS.width, height: CANVAS.height };
    } catch {
      return action;
    }
  }

  private async click(args: Record<string, unknown>) {
    await this.requireAccessibility();
    const { region, pid } = await this.regionFor(args);
    if (pid !== null) await desktop.activate(pid);
    const point = toScreen(region, number(args.x), number(args.y));
    const button = (["left", "right", "middle"].includes(String(args.button)) ? args.button : "left") as MouseButton;
    const count = Math.max(1, Math.min(3, number(args.count ?? args.click_count, 1)));
    await desktop.mouse({ kind: "click", ...point, button, count });
    return this.after({ action: "click", x: number(args.x), y: number(args.y), screen: point, button, count, success: true }, pid);
  }

  private async move(args: Record<string, unknown>) {
    await this.requireAccessibility();
    const { region, pid } = await this.regionFor(args);
    const point = toScreen(region, number(args.x), number(args.y));
    await desktop.mouse({ kind: "move", ...point });
    return this.after({ action: "move", x: number(args.x), y: number(args.y), screen: point, success: true }, pid);
  }

  private async drag(args: Record<string, unknown>) {
    await this.requireAccessibility();
    const { region, pid } = await this.regionFor(args);
    if (pid !== null) await desktop.activate(pid);
    const from = (args.from ?? { x: args.start_x, y: args.start_y }) as { x?: unknown; y?: unknown };
    const to = (args.to ?? { x: args.end_x, y: args.end_y }) as { x?: unknown; y?: unknown };
    const start = toScreen(region, number(from.x), number(from.y));
    const end = toScreen(region, number(to.x), number(to.y));
    const button = (["left", "right", "middle"].includes(String(args.button)) ? args.button : "left") as MouseButton;
    await desktop.mouse({ kind: "drag", ...start, to: end, button });
    return this.after({ action: "drag", from: start, to: end, success: true }, pid);
  }

  private async scroll(args: Record<string, unknown>) {
    await this.requireAccessibility();
    const { region, pid } = await this.regionFor(args);
    if (pid !== null) await desktop.activate(pid);
    const point = toScreen(region, number(args.x), number(args.y));
    const amount = Math.max(1, Math.min(50, number(args.amount, 3)));
    const direction = ["up", "down", "left", "right"].includes(String(args.direction)) ? String(args.direction) : "down";
    // Wheel ticks: positive moves content down the page view (wheel up), as macOS scroll events count them.
    const dy = direction === "up" ? amount : direction === "down" ? -amount : 0;
    const dx = direction === "left" ? amount : direction === "right" ? -amount : 0;
    await desktop.scroll(point.x, point.y, dx, dy);
    return this.after({ action: "scroll", direction, amount, screen: point, success: true }, pid);
  }

  private async pressKey(args: Record<string, unknown>) {
    await this.requireAccessibility();
    const chord = text(args.key);
    if (!chord) throw new Error("No key given");
    const pid = this.appTarget(args);
    if (pid !== null) await desktop.activate(pid);
    await desktop.key(chord);
    return this.after({ action: "key", key: chord, success: true }, pid);
  }

  private async typeText(args: Record<string, unknown>) {
    await this.requireAccessibility();
    const value = typeof args.text === "string" ? args.text : "";
    if (!value) throw new Error("No text given");
    const pid = this.appTarget(args);
    if (pid === null) throw new Error("Screen-scope typing is refused: type into an app target (from computer_apps or computer_resolve_app).");
    await desktop.activate(pid);
    if (args.element_id !== undefined) {
      const elementPath = this.element(args, pid);
      await desktop.accessibilitySetValue(pid, elementPath, "", true);
    }
    await desktop.typeText(value);
    return { action: "type", length: value.length, success: true };
  }

  /** computer_wait: short waits block here; the run loop suspends the run for long ones before they get here. */
  private async wait(args: Record<string, unknown>, signal?: AbortSignal) {
    const requested = Number(args.ms ?? args.duration_ms ?? 1000);
    const ms = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 30_000) : 1000;
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    return { elapsed_ms: Date.now() - started, ...(typeof args.reason === "string" ? { reason: args.reason } : {}) };
  }

  /** Reads the app's front-window accessibility tree (or the part under element_id) and numbers its elements. */
  private async appState(args: Record<string, unknown>) {
    await this.requireAccessibility();
    const pid = this.appTarget(args);
    if (pid === null) throw new Error("computer_app_state needs an app target (from computer_apps or computer_resolve_app).");
    const expanding = args.element_id !== undefined && text(args.snapshot_id);
    const snapshotId = expanding ? text(args.snapshot_id) : `snap_${Date.now().toString(36)}`;
    const snapshot: Snapshot = expanding ? this.snapshot(snapshotId, pid) : { pid, elements: new Map(), nextId: 1 };
    const root = expanding ? this.element(args, pid) : [];
    const nodes = (await desktop.accessibilityTree(pid, { root, limit: TREE_LIMIT })).map((node) => {
      const id = snapshot.nextId++;
      snapshot.elements.set(id, node.path);
      return { ...node, id };
    });
    this.snapshots.set(snapshotId, snapshot);
    // Keep only recent snapshots; ids from older ones are reported as stale.
    for (const old of [...this.snapshots.keys()].slice(0, -20)) this.snapshots.delete(old);
    if (!nodes.length) return { snapshot_id: snapshotId, pid, text: `(no elements)\nsnapshot_id=${snapshotId}` };
    return { snapshot_id: snapshotId, pid, count: nodes.length, text: formatTree(nodes, snapshotId) };
  }

  private snapshot(snapshotId: string, pid: number): Snapshot {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.pid !== pid) throw new Error("This snapshot is stale or unknown. Read computer_app_state again and use the new ids.");
    return snapshot;
  }

  private element(args: Record<string, unknown>, pid: number): number[] {
    const snapshot = this.snapshot(text(args.snapshot_id), pid);
    const elementPath = snapshot.elements.get(number(args.element_id, -1));
    if (!elementPath) throw new Error(`Element ${String(args.element_id)} is not in snapshot ${text(args.snapshot_id)}. Read computer_app_state again.`);
    return elementPath;
  }

  private async setValue(args: Record<string, unknown>) {
    await this.requireAccessibility();
    const pid = this.appTarget(args);
    if (pid === null) throw new Error("computer_set_value needs an app target.");
    const value = typeof args.value === "string" ? args.value : "";
    await desktop.accessibilitySetValue(pid, this.element(args, pid), value);
    return { action: "set_value", element_id: args.element_id, length: value.length, success: true };
  }

  private async appAction(args: Record<string, unknown>) {
    await this.requireAccessibility();
    const pid = this.appTarget(args);
    if (pid === null) throw new Error("computer_app_action needs an app target.");
    const action = axAction(text(args.action));
    await desktop.accessibilityAction(pid, this.element(args, pid), action);
    return { action: actionName(action), element_id: args.element_id, success: true };
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
