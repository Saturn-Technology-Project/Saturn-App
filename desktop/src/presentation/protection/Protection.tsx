import { desktop } from "../../application/desktop.js";
import { lockedPathOf } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;

/** What agents were refused and what changed, and plainly what each backend can and cannot enforce. */
export function Protection(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(async () => ({ events: (await service.events(projectId)).items, policy: await service.policy(projectId) }), props.notify);
  const events = [...(value?.events ?? [])].reverse();
  const released = value?.policy.released ?? [];

  async function release(path: string) {
    if (!value) return;
    try {
      await service.releaseLock(projectId, value.policy, path);
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  return (
    <Page title="Protection" lead="Modes and locks keep an agent to how you want to work. They are not a security boundary: a shell or another program can still write a file, and that is only noticed afterwards.">
      {released.length ? (
        <div className="lab-notice">
          Released until the next version is frozen: {released.join(", ")}. Freezing a version, as a run does, locks what it uses again.
        </div>
      ) : null}
      <h2>What has happened</h2>
      {events.length === 0 ? <p className="lab-muted">Nothing yet.</p> : null}
      {events.map((event, index) => {
        const locked = lockedPathOf(event);
        return (
          <div className="lab-row" key={`${event.at}-${index}`}>
            <span>
              {event.kind === "refused" ? <>Refused: {event.reason}</> : null}
              {event.kind === "integrity_changed" ? <>Changed, by someone or something: {event.paths.join(", ")} (noticed after {event.afterTool})</> : null}
              {event.kind === "assisted" ? <>You accepted a change to {event.path}</> : null}
            </span>
            {locked && !released.includes(locked) ? (
              <button type="button" className="lab-button" title="The current version keeps its results. The next run freezes a new version with the changed file." onClick={() => void release(locked)}>
                Let it change {locked} for the next version
              </button>
            ) : null}
            <span className="lab-muted">{new Date(event.at).toLocaleString()}</span>
          </div>
        );
      })}

      <h2>What each backend can enforce</h2>
      <div className="lab-table-wrap">
        <table className="lab-table">
          <thead>
            <tr>
              <th scope="col">Backend</th>
              <th scope="col">File tools</th>
              <th scope="col">Anything else</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>API and local models</td><td>Refused before writing</td><td>Compared afterwards</td></tr>
            <tr><td>Claude Code</td><td>Refused for the tools it asks about</td><td>Compared afterwards</td></tr>
            <tr><td>Codex</td><td>Cannot be refused per file</td><td>Compared after its turn</td></tr>
            <tr><td>MCP tools</td><td>Saturn cannot tell what they write</td><td>Compared afterwards</td></tr>
          </tbody>
        </table>
      </div>
    </Page>
  );
}
