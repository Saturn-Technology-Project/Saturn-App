import { desktop } from "../../application/desktop.js";
import { lockedPathOf } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Button } from "../ui/base/Button.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";
import { Heading, Row, Table } from "../home/Row.js";

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
        <Notice tone="wait" className="mt-3">
          Released until the next version is frozen: {released.join(", ")}. Freezing a version, as a run does, locks what it uses again.
        </Notice>
      ) : null}
      <Heading data-tour="protection-events">What has happened</Heading>
      {events.length === 0 ? <p className="text-xs text-muted-foreground">Nothing yet.</p> : null}
      {events.map((event, index) => {
        const locked = lockedPathOf(event);
        return (
          <Row key={`${event.at}-${index}`}>
            <span>
              {event.kind === "refused" ? <>Refused: {event.reason}</> : null}
              {event.kind === "integrity_changed" ? <>Changed, by someone or something: {event.paths.join(", ")} (noticed after {event.afterTool})</> : null}
              {event.kind === "assisted" ? <>You accepted a change to {event.path}</> : null}
            </span>
            {locked && !released.includes(locked) ? (
              <Button variant="outline" title="The current version keeps its results. The next run freezes a new version with the changed file." onClick={() => void release(locked)}>
                Let it change {locked} for the next version
              </Button>
            ) : null}
            <span className="text-xs text-muted-foreground">{new Date(event.at).toLocaleString()}</span>
          </Row>
        );
      })}

      <Heading>What each backend can enforce</Heading>
      <Table label="What each backend can enforce">
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
      </Table>
    </Page>
  );
}
