import { useCallback, useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { Automation, Conversation } from "../../domain/model.js";
import { messageOf } from "../ui/Parts.js";

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
    <div className="lab-older">
      <p className="lab-lead">Scheduled runs and pull request follow-up came from the earlier interface. The runtime keeps doing them until they are turned off here. They can use your models and your GitHub token.</p>
      {loaded && count === 0 ? <p className="lab-muted" style={{ marginTop: 12 }}>Nothing is still running.</p> : null}
      {count > 1 ? (
        <button
          type="button"
          className="lab-button"
          style={{ marginTop: 12 }}
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
        </button>
      ) : null}
      {automations.map((item) => (
        <div className="lab-row" key={item.id}>
          <span>
            {item.name} <span className="lab-muted">scheduled, on {item.agentName}</span>
          </span>
          <button type="button" className="lab-button" onClick={() => void act(() => desktop.automations.update(item.id, { enabled: false }))}>
            Turn off
          </button>
        </div>
      ))}
      {watched.map((thread) => (
        <div className="lab-row" key={thread.id}>
          <span>
            {thread.title} <span className="lab-muted">pull request {thread.pullRequest?.url}</span>
          </span>
          <button type="button" className="lab-button" onClick={() => void act(() => desktop.catalog.watchPullRequest(thread.id, false))}>
            Stop following
          </button>
        </div>
      ))}
    </div>
  );
}
