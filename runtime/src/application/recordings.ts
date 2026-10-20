import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { HttpError } from "../domain/errors.js";
import type { RuntimeKernel } from "./kernel.js";

/**
 * The screencasts a run recorded with the browser tools: JPEG frames under `<data>/workspace/recordings/<name>/`
 * (see browser-skill.ts). The apps play the frames themselves; ffmpeg, when installed, turns one into an MP4.
 */
export class RecordingService {
  constructor(private readonly kernel: RuntimeKernel) {}

  private root(): string {
    return path.join(this.kernel.store.root, "workspace", "recordings");
  }

  /** The recordings a run's browser_record_stop results point at, with their frame counts. */
  list(runId: string): { name: string; frames: number; seconds?: number; exported?: boolean }[] {
    const run = this.kernel.getRun(runId);
    const found: { name: string; frames: number; seconds?: number; exported?: boolean }[] = [];
    for (const action of run.actions) {
      if (action.toolId !== "browser_record_stop" || action.status !== "completed") continue;
      const result = (action.result ?? {}) as { recording?: string; frames?: number; seconds?: number };
      if (typeof result.recording !== "string") continue;
      const folder = this.folder(result.recording);
      if (!folder) continue;
      const name = path.basename(folder);
      if (found.some((item) => item.name === name)) continue;
      const frames = readdirSync(folder).filter((file) => /^frame-\d+\.jpg$/.test(file)).length;
      found.push({ name, frames, ...(typeof result.seconds === "number" ? { seconds: result.seconds } : {}), exported: existsSync(path.join(folder, "out.mp4")) });
    }
    return found;
  }

  /** The absolute path of one frame (1-based index) of a run's recording. */
  frame(runId: string, name: string, index: number): string {
    const recording = this.list(runId).find((item) => item.name === name);
    if (!recording) throw new HttpError(404, "This run has no such recording");
    if (!Number.isInteger(index) || index < 1 || index > recording.frames) throw new HttpError(404, "No such frame");
    return path.join(this.root(), name, `frame-${String(index).padStart(5, "0")}.jpg`);
  }

  /** Writes out.mp4 next to the frames with ffmpeg (10 fps), or says ffmpeg is missing. */
  async exportMp4(runId: string, name: string): Promise<{ path: string }> {
    const recording = this.list(runId).find((item) => item.name === name);
    if (!recording) throw new HttpError(404, "This run has no such recording");
    const folder = path.join(this.root(), name);
    const target = path.join(folder, "out.mp4");
    if (existsSync(target)) return { path: target };
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "frames.txt", "-r", "10", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "out.mp4"], { cwd: folder, timeout: 5 * 60 * 1000 }, (error) => {
        if (!error) return resolve();
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new HttpError(missing ? 409 : 500, missing ? "ffmpeg is not installed; install it (brew install ffmpeg) to export MP4s. The frames play in the app without it." : `ffmpeg failed: ${error.message}`));
      });
    });
    return { path: target };
  }

  /** A recording folder from a tool result, only when it is one of Saturn's own under the data directory. */
  private folder(recorded: string): string | undefined {
    const full = path.resolve(recorded);
    const root = this.root();
    if (!full.startsWith(root + path.sep) || path.dirname(full) !== root) return undefined;
    try {
      return statSync(full).isDirectory() ? full : undefined;
    } catch {
      return undefined;
    }
  }
}
