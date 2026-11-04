import { desktop } from "../../application/desktop.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

/** What agents were refused and what changed, and plainly what each backend can and cannot enforce. */
export function Protection(props: ScreenProps) {
  const { value } = useRecords(async () => (await desktop.research.events(props.project.id)).items, props.notify);
  const events = [...(value ?? [])].reverse();
  return (
    <Page title="Protection" lead="Modes and locks keep an agent to how you want to work. They are not a security boundary: a shell or another program can still write a file, and that is only noticed afterwards.">
      <h2>What has happened</h2>
      {events.length === 0 ? <p className="lab-muted">Nothing yet.</p> : null}
      {events.map((event, index) => (
        <div className="lab-row" key={`${event.at}-${index}`}>
          <span>
            {event.kind === "refused" ? <>Refused: {event.reason}</> : null}
            {event.kind === "integrity_changed" ? <>Changed, by someone or something: {event.paths.join(", ")} (noticed after {event.afterTool})</> : null}
            {event.kind === "assisted" ? <>You accepted a change to {event.path}</> : null}
          </span>
          <span className="lab-muted">{new Date(event.at).toLocaleString()}</span>
        </div>
      ))}

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
