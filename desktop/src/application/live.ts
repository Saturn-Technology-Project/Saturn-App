import type { RuntimeClient } from "../infrastructure/runtime-client.js";
import type { AgentBrowserFrame, AgentBrowserState, Run } from "../domain/model.js";

/** What the runtime's /events stream says after a change: the runs that changed, and whether anything else did. */
export type LiveChange = { runs: { id: string; threadId?: string; agentId: string; status: string; parentRunId?: string }[]; other: boolean };

/**
 * One connection to the runtime's /events stream for the whole app, reconnecting with a short backoff. Screens
 * subscribe to changes and refresh what they show; `connected` lets them poll slowly as a fallback while it is up.
 */
export class LiveService {
  private readonly listeners = new Set<(change: LiveChange) => void>();
  private readonly statusListeners = new Set<(connected: boolean) => void>();
  private controller: AbortController | null = null;
  connected = false;

  constructor(private readonly runtime: RuntimeClient) {}

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    for (const listener of this.statusListeners) listener(value);
  }

  private start() {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    const loop = async () => {
      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          await this.runtime.stream("/events", (event, data) => {
            if (event === "ready") {
              this.setConnected(true);
              delay = 1000;
              // Whatever happened while disconnected: everyone refreshes once.
              for (const listener of this.listeners) listener({ runs: [], other: true });
            } else if (event === "change") {
              for (const listener of this.listeners) listener(data as LiveChange);
            }
          }, controller.signal);
        } catch {
          // The runtime is restarting or older than this app; retried below.
        }
        this.setConnected(false);
        if (controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 15_000);
      }
    };
    void loop();
  }

  /** Calls `listener` after every change; returns the unsubscribe. The stream opens with the first subscriber. */
  onChange(listener: (change: LiveChange) => void): () => void {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.connected);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** The agent's browser live: its state when it opens, closes or navigates, and its page's frames; until `signal` aborts. */
  watchBrowser(onState: (state: AgentBrowserState) => void, onFrame: (frame: AgentBrowserFrame) => void, signal: AbortSignal): Promise<void> {
    return this.runtime.stream("/browser/live", (event, data) => {
      if (event === "state") onState(data as AgentBrowserState);
      else if (event === "frame") onFrame(data as AgentBrowserFrame);
    }, signal);
  }

  /** One run as it changes, until `signal` aborts; resolves when the stream ends, rejects when it cannot open. */
  watchRun(runId: string, onRun: (run: Run) => void, signal: AbortSignal): Promise<void> {
    return this.runtime.stream(`/runs/${encodeURIComponent(runId)}/events`, (event, data) => {
      if (event === "run") onRun(data as Run);
    }, signal);
  }
}
