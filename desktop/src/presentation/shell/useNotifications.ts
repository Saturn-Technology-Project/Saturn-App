import { useEffect, useRef } from "react";
import { desktop } from "../../application/desktop.js";

/** While the window is in the background, says when a task needs a decision or has ended; clicking opens Tasks. */
export function useNotifications(): void {
  const told = useRef(new Set<string>());
  useEffect(
    () =>
      desktop.live.onChange((change) => {
        const notify = window.saturnDesktop?.notify;
        if (!notify || window.saturnDesktop?.isFocused?.()) return;
        for (const run of change.runs) {
          const key = `${run.id}:${run.status}`;
          if (told.current.has(key)) continue;
          const title = run.status === "waiting_approval" ? "A task needs your decision" : run.status === "completed" ? "A task finished" : run.status === "failed" ? "A task failed" : null;
          if (!title) continue;
          told.current.add(key);
          notify({ title, agentId: run.agentId, threadId: run.threadId });
        }
      }),
    [],
  );
}
