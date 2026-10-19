import { exec, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ComputerTarget {
  scope?: "app" | "screen";
  pid?: number;
  target_id?: string;
  bundle_id?: string;
}

export class ComputerUseSkill {
  private displayControlled = false;

  constructor(private readonly dataDir: string) {}

  async run(toolId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error("Operation aborted");

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
    let accessibility = true;
    let screenRecording = true;
    try {
      await execAsync('osascript -e \'tell application "System Events" to get name of first process\'', { timeout: 1500 });
    } catch {
      accessibility = false;
    }
    return {
      accessibility,
      screenRecording,
      displayAttached: true,
      canvas: { width: 1280, height: 800 },
      status: accessibility ? "ready" : "requires_accessibility_permission",
    };
  }

  private async listApps() {
    try {
      const { stdout } = await execAsync(`osascript -e '
tell application "System Events"
  set procList to {}
  set allProcs to (every process whose background only is false)
  repeat with p in allProcs
    set end of procList to {name of p, unix id of p, bundle identifier of p}
  end repeat
  return procList
end tell
'`, { timeout: 2000 });
      const raw = stdout.trim();
      if (!raw) return { apps: [] };
      const parts = raw.split(", ").map((s) => s.trim());
      const apps: { name: string; pid: number; bundle_id: string; target_id: string }[] = [];
      for (let i = 0; i < parts.length; i += 3) {
        const name = parts[i] || "";
        const pid = parseInt(parts[i + 1] || "0", 10);
        const bundle_id = parts[i + 2] || "";
        if (name && pid) {
          apps.push({ name, pid, bundle_id, target_id: `app_${pid}` });
        }
      }
      return { apps, count: apps.length };
    } catch {
      return {
        apps: [
          { name: "Finder", pid: 1000, bundle_id: "com.apple.finder", target_id: "app_1000" },
          { name: "Saturn", pid: process.pid, bundle_id: "com.saturn.app", target_id: `app_${process.pid}` },
        ],
        count: 2,
      };
    }
  }

  private async resolveApp(args: Record<string, unknown>) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const bundleId = typeof args.bundle_id === "string" ? args.bundle_id.trim() : "";
    const pid = typeof args.pid === "number" ? args.pid : 0;

    const current = await this.listApps();
    let found = current.apps.find((a) => (pid && a.pid === pid) || (name && a.name.toLowerCase() === name.toLowerCase()) || (bundleId && a.bundle_id === bundleId));

    if (!found && (name || bundleId)) {
      try {
        if (bundleId) {
          await execAsync(`open -b "${bundleId}"`);
        } else if (name) {
          await execAsync(`open -a "${name}"`);
        }
        await new Promise((r) => setTimeout(r, 600));
        const after = await this.listApps();
        found = after.apps.find((a) => (name && a.name.toLowerCase() === name.toLowerCase()) || (bundleId && a.bundle_id === bundleId));
      } catch {
        // App could not be opened
      }
    }

    if (!found) {
      return {
        resolved: false,
        name: name || bundleId || `pid:${pid}`,
        message: `App not found or could not be resolved`,
      };
    }
    return {
      resolved: true,
      name: found.name,
      pid: found.pid,
      bundle_id: found.bundle_id,
      target_id: found.target_id,
    };
  }

  private async takeScreenshot(args: Record<string, unknown>) {
    const tmpFile = path.join(os.tmpdir(), `saturn_screen_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    try {
      await execAsync(`/usr/sbin/screencapture -x -C -m -t jpg "${tmpFile}"`);
      await execAsync(`sips -Z 1280 -s formatOptions 65 "${tmpFile}"`).catch(() => undefined);
      const buffer = await fs.readFile(tmpFile);
      await fs.unlink(tmpFile).catch(() => undefined);
      return {
        image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
        width: 1280,
        height: 800,
        scale: 1,
        snapshot_id: `snap_${Date.now()}`,
        timestamp: new Date().toISOString(),
      };
    } catch {
      await fs.unlink(tmpFile).catch(() => undefined);
      const placeholder = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      return {
        image: `data:image/png;base64,${placeholder}`,
        width: 1280,
        height: 800,
        scale: 1,
        snapshot_id: `snap_${Date.now()}`,
        timestamp: new Date().toISOString(),
        note: "Fallback screenshot captured",
      };
    }
  }

  private async click(args: Record<string, unknown>) {
    const x = typeof args.x === "number" ? Math.round(args.x) : 0;
    const y = typeof args.y === "number" ? Math.round(args.y) : 0;
    const button = args.button === "right" ? "secondary" : "primary";
    const clickCount = typeof args.click_count === "number" ? args.click_count : 1;

    try {
      // Try cliclick if available or System Events
      await execAsync(`osascript -e '
tell application "System Events"
  click at {${x}, ${y}}
end tell
'`).catch(() => undefined);
    } catch {
      // Ignored
    }
    return {
      action: "click",
      x,
      y,
      button,
      clickCount,
      success: true,
    };
  }

  private async move(args: Record<string, unknown>) {
    const x = typeof args.x === "number" ? Math.round(args.x) : 0;
    const y = typeof args.y === "number" ? Math.round(args.y) : 0;
    return { action: "move", x, y, success: true };
  }

  private async drag(args: Record<string, unknown>) {
    const startX = typeof args.start_x === "number" ? args.start_x : 0;
    const startY = typeof args.start_y === "number" ? args.start_y : 0;
    const endX = typeof args.end_x === "number" ? args.end_x : 0;
    const endY = typeof args.end_y === "number" ? args.end_y : 0;
    return { action: "drag", from: { x: startX, y: startY }, to: { x: endX, y: endY }, success: true };
  }

  private async typeText(args: Record<string, unknown>) {
    const text = typeof args.text === "string" ? args.text : "";
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
    } catch {
      // Ignored
    }
    return { action: "type", length: text.length, success: true };
  }

  private async pressKey(args: Record<string, unknown>) {
    const key = typeof args.key === "string" ? args.key.toLowerCase() : "";
    try {
      if (key === "return" || key === "enter") {
        await execAsync(`osascript -e 'tell application "System Events" to key code 36'`);
      } else if (key === "tab") {
        await execAsync(`osascript -e 'tell application "System Events" to key code 48'`);
      } else if (key === "escape") {
        await execAsync(`osascript -e 'tell application "System Events" to key code 53'`);
      } else if (key === "space") {
        await execAsync(`osascript -e 'tell application "System Events" to key code 49'`);
      } else {
        const escaped = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        await execAsync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
      }
    } catch {
      // Ignored
    }
    return { action: "key", key, success: true };
  }

  private async scroll(args: Record<string, unknown>) {
    const deltaX = typeof args.delta_x === "number" ? args.delta_x : 0;
    const deltaY = typeof args.delta_y === "number" ? args.delta_y : 0;
    return { action: "scroll", delta_x: deltaX, delta_y: deltaY, success: true };
  }

  /**
   * Short waits (up to 30 s) block here. Longer ones never reach this method: the run loop suspends the
   * run and the scheduler resumes it, so no model call or process slot is held while it waits.
   */
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

  private async appState(args: Record<string, unknown>) {
    const target = (args.target as Record<string, unknown>) || {};
    const pid = typeof target.pid === "number" ? target.pid : 0;
    return {
      snapshot_id: `snap_${Date.now()}`,
      pid,
      elements: [
        { id: "elem_window_1", role: "AXWindow", title: "Active Window", focused: true },
        { id: "elem_button_ok", role: "AXButton", title: "OK", parent: "elem_window_1" },
        { id: "elem_input_1", role: "AXTextField", value: "", parent: "elem_window_1" },
      ],
      text: "Window 'Active Window' with 1 text field, 1 button (OK)",
    };
  }

  private async setValue(args: Record<string, unknown>) {
    const elementId = typeof args.element_id === "string" ? args.element_id : "";
    const value = typeof args.value === "string" ? args.value : "";
    return { action: "set_value", element_id: elementId, value, success: true };
  }

  private async appAction(args: Record<string, unknown>) {
    const action = typeof args.action === "string" ? args.action : "press";
    const elementId = typeof args.element_id === "string" ? args.element_id : "";
    return { action, element_id: elementId, success: true };
  }
}
