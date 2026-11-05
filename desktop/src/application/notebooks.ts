import type { KernelEvent, KernelStatus } from "../domain/notebook.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

/** How long to wait before following a kernel's events again after the connection dropped. */
const RECONNECT_DELAY = 1000;

/** The kernels of notebooks open in the Workspace. Running one is the person's own action: it adds nothing to the research records. */
export class NotebookService {
  constructor(private readonly runtime: RuntimeClient) {}

  private route(project: string): string {
    return `/projects/${encodeURIComponent(project)}/research/notebook`;
  }

  private act<T>(project: string, action: string, body: unknown): Promise<T> {
    return this.runtime.request<T>(`${this.route(project)}/${action}`, { method: "POST", body: JSON.stringify(body) });
  }

  /** What the runtime holds for this notebook, if anything. */
  status(project: string, path: string): Promise<KernelStatus> {
    return this.runtime.request(`${this.route(project)}?path=${encodeURIComponent(path)}`);
  }

  /** Queues cells to run in order. The runtime starts a kernel when there is none. */
  run(project: string, path: string, cells: { cell: string; code: string }[]): Promise<KernelStatus> {
    return this.act(project, "run", { path, cells });
  }

  /** Interrupts the running cell. */
  interrupt(project: string, path: string): Promise<KernelStatus> {
    return this.act(project, "interrupt", { path });
  }

  /** Restarts the kernel, losing what it holds in memory. */
  restart(project: string, path: string): Promise<KernelStatus> {
    return this.act(project, "restart", { path });
  }

  /** Stops the notebook's kernel; one it does not have is fine. */
  stop(project: string, path: string): Promise<{ stopped: boolean }> {
    return this.act(project, "stop", { path });
  }

  /**
   * Follows a kernel's events from `from` until it ends or `signal` aborts. A dropped connection is picked up where it
   * stopped; a kernel that has gone ends this, as nothing more can come from it.
   */
  async follow(project: string, path: string, kernel: string, from: number, onEvent: (event: KernelEvent) => void, signal: AbortSignal): Promise<void> {
    let next = from;
    let ended = false;
    while (!ended && !signal.aborted) {
      try {
        await this.runtime.stream(
          `${this.route(project)}/events?path=${encodeURIComponent(path)}&kernel=${encodeURIComponent(kernel)}&after=${next}`,
          (_, data) => {
            const event = data as KernelEvent;
            if (event.type !== "gap") next = event.seq + 1;
            if (event.type === "ended") ended = true;
            onEvent(event);
          },
          signal,
        );
        // A stream that ends by itself has told all it has, or the runtime is going.
        if (!ended && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));
      } catch (error) {
        if (error instanceof Error && /kernel has ended/i.test(error.message)) return;
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));
      }
    }
  }
}
