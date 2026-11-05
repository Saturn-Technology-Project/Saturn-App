import { useCallback, useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { Automation, Conversation } from "../../domain/model.js";
import { Button } from "../ui/base/Button.js";
import { messageOf } from "../ui/Parts.js";

/** A feature that is still running: what it is on the left, the button that turns it off on the right. */
const OLDER_ROW = "mt-1 flex min-h-10 flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5";
const OLDER_TEXT = "min-w-0 flex-[1_1_220px] [overflow-wrap:anywhere]";

/**
 * What the earlier interface set going and the runtime still does: nothing else shows it now, so it is listed here to
 * be turned off. Turning something off changes only that it runs; its record stays.
 */
export function OlderFeatures(props: { onError: (message: string) => void }) {
  const { onError } = props;
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [watched, setWatched] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const agents = await desktop.catalog.listAgents();
      const threads = (await Promise.all(agents.map((agent) => desktop.catalog.listThreads(agent.id)))).flat();
      setAutomations((await desktop.automations.list()).filter((item) => item.enabled));
      setWatched(threads.filter((thread) => thread.pullRequest?.watching));
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setLoaded(true);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
    } catch (error) {
      onError(messageOf(error));
    }
  }

  const count = automations.length + watched.length;
  return (
    <div>
      <p className="max-w-[680px] text-muted-foreground">Scheduled runs and pull request follow-up came from the earlier interface. The runtime keeps doing them until they are turned off here. They can use your models and your GitHub token.</p>
      {loaded && count === 0 ? <p className="mt-3 text-xs text-muted-foreground">Nothing is still running.</p> : null}
      {count > 1 ? (
        <Button
          type="button"
          variant="outline"
          className="mt-3"
          onClick={() =>
            void act(() =>
              Promise.all([
                ...automations.map((item) => desktop.automations.update(item.id, { enabled: false })),
                ...watched.map((thread) => desktop.catalog.watchPullRequest(thread.id, false)),
              ]),
            )
          }
        >
          Turn them all off
        </Button>
      ) : null}
      {automations.map((item) => (
        <div className={OLDER_ROW} key={item.id}>
          <span className={OLDER_TEXT}>
            {item.name} <span className="text-xs text-muted-foreground">scheduled, on {item.agentName}</span>
          </span>
          <Button type="button" variant="outline" onClick={() => void act(() => desktop.automations.update(item.id, { enabled: false }))}>
            Turn off
          </Button>
        </div>
      ))}
      {watched.map((thread) => (
        <div className={OLDER_ROW} key={thread.id}>
          <span className={OLDER_TEXT}>
            {thread.title} <span className="text-xs text-muted-foreground">pull request {thread.pullRequest?.url}</span>
          </span>
          <Button type="button" variant="outline" onClick={() => void act(() => desktop.catalog.watchPullRequest(thread.id, false))}>
            Stop following
          </Button>
        </div>
      ))}
    </div>
  );
}
