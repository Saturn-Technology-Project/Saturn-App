import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
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
    <Page title={t("Protection")} lead={t("Modes and locks keep an agent to how you want to work. They are not a security boundary: a shell or another program can still write a file, and that is only noticed afterwards.")}>
      {released.length ? (
        <Notice tone="wait" className="mt-3">
          {t("Released until the next version is frozen: {paths}. Freezing a version, as a run does, locks what it uses again.", { paths: released.join(", ") })}
        </Notice>
      ) : null}
      <Heading data-tour="protection-events">{t("What has happened")}</Heading>
      {events.length === 0 ? <p className="text-xs text-muted-foreground">{t("Nothing yet.")}</p> : null}
      {events.map((event, index) => {
        const locked = lockedPathOf(event);
        return (
          <Row key={`${event.at}-${index}`}>
            <span>
              {event.kind === "refused" ? t("Refused: {reason}", { reason: event.reason }) : null}
              {event.kind === "integrity_changed" ? t("Changed, by someone or something: {paths} (noticed after {tool})", { paths: event.paths.join(", "), tool: event.afterTool }) : null}
              {event.kind === "assisted" ? t("You accepted a change to {path}", { path: event.path }) : null}
            </span>
            {locked && !released.includes(locked) ? (
              <Button variant="outline" title={t("The current version keeps its results. The next run freezes a new version with the changed file.")} onClick={() => void release(locked)}>
                {t("Let it change {path} for the next version", { path: locked })}
              </Button>
            ) : null}
            <span className="text-xs text-muted-foreground">{new Date(event.at).toLocaleString()}</span>
          </Row>
        );
      })}

      <Heading>{t("What each backend can enforce")}</Heading>
      <Table label={t("What each backend can enforce")}>
        <thead>
          <tr>
            <th scope="col">{t("Backend")}</th>
            <th scope="col">{t("File tools")}</th>
            <th scope="col">{t("Anything else")}</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>{t("API and local models")}</td><td>{t("Refused before writing")}</td><td>{t("Compared afterwards")}</td></tr>
          <tr><td>Claude Code</td><td>{t("Refused for the tools it asks about")}</td><td>{t("Compared afterwards")}</td></tr>
          <tr><td>Codex</td><td>{t("Cannot be refused per file")}</td><td>{t("Compared after its turn")}</td></tr>
          <tr><td>{t("MCP tools")}</td><td>{t("Saturn cannot tell what they write")}</td><td>{t("Compared afterwards")}</td></tr>
        </tbody>
      </Table>
    </Page>
  );
}
