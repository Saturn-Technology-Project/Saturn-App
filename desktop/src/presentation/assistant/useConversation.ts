import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { isBusy, upsertRun } from "../../domain/conversation.js";
import type { Run, RunMode } from "../../domain/model.js";
import { messageOf } from "../ui/Parts.js";

/** One chat's turns, kept current from the runtime: the run's own stream while it lasts, and the chat on every change. */
export function useConversation(agentId: string | null, threadId: string | null, notify: (message: string) => void) {
  const [runs, setRuns] = useState<Run[]>([]);
  const streams = useRef(new Set<AbortController>());

  const pull = useCallback(async () => {
    if (!agentId || !threadId) return;
    try {
      setRuns(await desktop.catalog.messages(agentId, threadId));
    } catch {
      // Kept as they are until the runtime answers.
    }
  }, [agentId, threadId]);

  useEffect(() => {
    setRuns([]);
    void pull();
    const timer = window.setInterval(() => void pull(), desktop.live.connected ? 30_000 : 2000);
    const stop = desktop.live.onChange((change) => {
      if (change.other || change.runs.some((run) => run.threadId === threadId)) void pull();
    });
    const open = streams.current;
    return () => {
      window.clearInterval(timer);
      stop();
      for (const stream of open) stream.abort();
      open.clear();
    };
  }, [pull, threadId]);

  const watch = useCallback((runId: string) => {
    const stream = new AbortController();
    streams.current.add(stream);
    void desktop.live
      .watchRun(
        runId,
        (current) => {
          setRuns((list) => upsertRun(list, current));
          if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") stream.abort();
        },
        stream.signal,
      )
      // A stream that cannot open is covered by the chat's own refresh.
      .catch(() => {})
      .finally(() => streams.current.delete(stream));
  }, []);

  const send = useCallback(
    async (input: string, mode: RunMode) => {
      if (!agentId || !threadId) return false;
      try {
        const started = await desktop.runs.start(agentId, input, threadId, { mode });
        setRuns((list) => upsertRun(list, started));
        watch(started.id);
        return true;
      } catch (error) {
        notify(messageOf(error));
        return false;
      }
    },
    [agentId, notify, threadId, watch],
  );

  const stop = useCallback(
    async (run: Run) => {
      try {
        const stopped = await desktop.runs.stop(run.id);
        setRuns((list) => upsertRun(list, stopped));
      } catch (error) {
        notify(messageOf(error));
      }
    },
    [notify],
  );

  // A run already going when this opens still streams.
  const latest = runs.at(-1);
  const latestId = isBusy(latest) ? latest?.id : undefined;
  useEffect(() => {
    if (latestId) watch(latestId);
  }, [latestId, watch]);

  return { runs, busy: isBusy(latest) || latest?.status === "waiting_approval", latest, send, stop, pull };
}
