import { useEffect, useState } from "react";
import { RuntimeClient } from "./runtime-client.js";

/** Where the runtime stands, as the desktop app reports it; a plain browser only knows whether it answers. */
export type RuntimeStatus =
  | { state: "starting"; attempt: number; log: string[] }
  | { state: "ready"; version: string; own: boolean }
  | { state: "blocked"; reason: string }
  | { state: "failed"; reason: string; log: string[] };

/** Asks the app, or in a plain browser the runtime itself. */
async function readStatus(client: RuntimeClient): Promise<RuntimeStatus> {
  const fromApp = window.saturnDesktop?.runtimeStatus;
  if (fromApp) return fromApp();
  try {
    const answer = await client.request<{ version?: string }>("/health");
    return { state: "ready", version: answer.version ?? "unknown", own: false };
  } catch {
    return { state: "starting", attempt: 0, log: [] };
  }
}

/** The runtime's state, asked for often while it is not ready and now and then once it is. */
export function useRuntimeStatus(): { status: RuntimeStatus; restart: (() => Promise<void>) | null } {
  const [status, setStatus] = useState<RuntimeStatus>({ state: "starting", attempt: 0, log: [] });
  useEffect(() => {
    const client = new RuntimeClient();
    let live = true;
    let timer = 0;
    const ask = async () => {
      const next = await readStatus(client);
      if (!live) return;
      setStatus((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      timer = window.setTimeout(() => void ask(), next.state === "ready" ? 3000 : 1000);
    };
    void ask();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);
  const restart = window.saturnDesktop?.restartRuntime ?? null;
  return { status, restart: restart ? () => restart() : null };
}
