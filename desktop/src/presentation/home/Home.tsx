import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { changedSince, lastActive, reviewProgress, runHasResults, runStatusLabel, type Hypothesis, type Verdict } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";
import { Heading, Row } from "./Row.js";
import { ImportResults } from "../experiments/ImportResults.js";
import { ResearchBundle } from "../experiments/ResearchBundle.js";

const service = desktop.research;
const VERDICTS: Verdict[] = ["undecided", "supported", "refuted", "inconclusive"];
const VERDICT_OPTIONS = VERDICTS.map((verdict) => ({ value: verdict, label: verdict[0].toUpperCase() + verdict.slice(1) }));
const MUTED = "text-xs text-muted-foreground";

/** A moment in words, for saying when the work stopped. */
function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

/** Where the work stopped, what was restored, what changed since this device last looked, and what is still open. */
export function Home(props: ScreenProps) {
  const projectId = props.project.id;
  // The visit is marked once, when the screen opens, so the list says what changed since the time before.
  const [visited] = useState(() => service.visit(projectId));
  const [session] = useState(() => service.loadSession(projectId));
  const { value, refresh } = useRecords(
    async () => {
      const runs = (await service.runs(projectId)).items;
      const last = [...runs].reverse().find((run) => runHasResults(run.status)) ?? null;
      return {
        questions: (await service.questions(projectId)).items,
        hypotheses: (await service.hypotheses(projectId)).items,
        runs,
        findings: (await service.findings(projectId)).items,
        events: (await service.events(projectId)).items,
        review: last ? reviewProgress(await service.summary(projectId, last.id), await service.labels(projectId, last.id)) : null,
        lastWithResults: last,
      };
    },
    props.notify,
  );
  const [question, setQuestion] = useState("");
  const [hypothesis, setHypothesis] = useState("");

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  const lastRun = value?.runs.at(-1);
  const lastFinding = value?.findings.at(-1);
  const lastQuestion = value?.questions.at(-1);
  const undecided = value?.hypotheses.filter((item) => item.verdict === "undecided") ?? [];
  const alerts = value?.events.filter((event) => event.kind !== "assisted") ?? [];
  const troubled = value?.runs.filter((run) => run.status === "interrupted" || run.status === "failed" || run.status === "protocol_error") ?? [];
  const active = value ? lastActive([value.runs, value.findings, value.hypotheses, value.questions]) : null;
  const since = value
    ? [
        ...changedSince(value.runs, visited).map((run) => ({ key: run.id, at: run.updatedAt, text: `Run ${run.id}: ${runStatusLabel(run.status)}, ${run.samples ?? 0} samples`, screen: "Experiments" as const })),
        ...changedSince(value.findings, visited).map((item) => ({ key: item.id, at: item.updatedAt, text: `${item.kind === "conclusion" ? "Conclusion" : item.kind === "ai_suggestion" ? "AI suggestion" : "Observation"}: ${item.text}`, screen: "Experiments" as const })),
        ...changedSince(value.hypotheses, visited).map((item) => ({ key: item.id, at: item.updatedAt, text: `Hypothesis ${item.verdict}: ${item.title}`, screen: "Experiments" as const })),
        ...value.events.filter((event) => !visited || event.at > visited).map((event, index) => ({ key: `${event.at}-${index}`, at: event.at, text: event.kind === "refused" ? `Refused: ${event.reason}` : event.kind === "integrity_changed" ? `Changed outside Saturn: ${event.paths.join(", ")}` : `Accepted a change to ${event.path}`, screen: "Protection" as const })),
      ].sort((left, right) => (left.at < right.at ? 1 : -1))
    : [];
  const restored = [
    session.file ? `${session.file} in the editor` : null,
    session.draft ? `an unsaved draft of ${session.draft.file}` : null,
    session.runId ? `run ${session.runId}` : null,
  ].filter(Boolean);

  return (
    <Page title={lastQuestion ? lastQuestion.title : `Start ${props.project.name}`} lead={lastFinding ? `Latest note: ${lastFinding.text}` : "Write down the question this project is trying to answer, then work on it."}>
      {active ? <div className={MUTED}>Last active {when(active)}</div> : null}
      <ImportResults projectId={projectId} onImported={() => { void refresh(); props.go("Experiments"); }} notify={props.notify} />
      <ResearchBundle projectId={projectId} notify={props.notify} go={props.go} onImported={() => void refresh()} />
      <div className="mt-3.5 flex flex-wrap items-end gap-2">
        <Button onClick={() => props.go("Workspace")}>
          {restored.length ? "Restore last layout" : "Continue in the workspace"}
        </Button>
        {value?.lastWithResults ? (
          <Button variant="outline" onClick={() => { service.open(projectId, { kind: "sample", runId: value.lastWithResults!.id }); props.go("Samples"); }}>
            Continue sample review{value.review ? ` (${value.review.labeled} of ${value.review.total})` : ""}
          </Button>
        ) : null}
      </div>

      {restored.length ? (
        <>
          <Heading>Restored as it was</Heading>
          <Card className="gap-1 border-0 bg-panel px-3.5 py-3">
            <div>The workspace reopens with {restored.join(", ")}.</div>
            <div className={MUTED}>Records come from the project folder; what was open comes from this device.</div>
          </Card>
        </>
      ) : null}

      <Heading>Since your last visit</Heading>
      {visited ? <div className={MUTED}>On this device, {when(visited)}.</div> : <div className={MUTED}>First visit on this device, so everything is new.</div>}
      {since.length === 0 ? <p className={MUTED}>Nothing changed.</p> : null}
      {since.slice(0, 8).map((item) => (
        <Row key={item.key}>
          <span>{item.text}</span>
          <Button variant="ghost" size="small" className="text-info" onClick={() => props.go(item.screen)}>
            {item.screen === "Protection" ? "Decide" : "See"}
          </Button>
        </Row>
      ))}

      <Heading>Open</Heading>
      <Card className="gap-0 border-0 bg-panel px-3.5 py-3">
        <Row>
          <span>Latest run</span>
          <span className={MUTED}>{lastRun ? `${runStatusLabel(lastRun.status)}, ${lastRun.samples ?? 0} samples, ${when(lastRun.updatedAt)}` : "None yet"}</span>
        </Row>
        {undecided.map((item) => (
          <Row key={item.id}>
            <span>{item.title}</span>
            <span className={MUTED}>Undecided</span>
          </Row>
        ))}
        {troubled.map((run) => (
          <Row key={run.id}>
            <span>Run {run.id}</span>
            <span className={MUTED}>{runStatusLabel(run.status)}</span>
          </Row>
        ))}
        <Row>
          <span>Refusals and unexplained changes</span>
          {alerts.length ? (
            <Button variant="ghost" size="small" className="text-info" onClick={() => props.go("Protection")}>
              {alerts.length} to look at
            </Button>
          ) : (
            <span className={MUTED}>None</span>
          )}
        </Row>
      </Card>

      <Heading data-tour="home-questions">Questions</Heading>
      {value?.questions.map((item) => (
        <Row key={item.id}>
          <span>{item.title}</span>
        </Row>
      ))}
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim()) {
            void act(async () => {
              await service.addQuestion(projectId, question.trim());
              setQuestion("");
            });
          }
        }}
      >
        <Field label="New question" className="flex-[1_1_160px]">
          <Input value={question} onChange={(event) => setQuestion(event.target.value)} />
        </Field>
        <Button type="submit" variant="outline" disabled={!question.trim()}>
          Add
        </Button>
      </form>

      <Heading data-tour="home-hypotheses">Hypotheses</Heading>
      <p className="max-w-[680px] text-muted-foreground">A verdict is yours to set. A run that completes says only that it executed.</p>
      {value?.hypotheses.map((item: Hypothesis) => (
        <Row key={item.id}>
          <span>{item.title}</span>
          <Choice label="Verdict" className="flex-row items-center gap-2" triggerClassName="w-36" value={item.verdict} options={VERDICT_OPTIONS} onChange={(verdict) => void act(() => service.setVerdict(projectId, item, verdict as Verdict))} />
        </Row>
      ))}
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (hypothesis.trim()) {
            void act(async () => {
              await service.addHypothesis(projectId, hypothesis.trim(), lastQuestion?.id);
              setHypothesis("");
            });
          }
        }}
      >
        <Field label="New hypothesis" className="flex-[1_1_160px]">
          <Input value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} />
        </Field>
        <Button type="submit" variant="outline" disabled={!hypothesis.trim()}>
          Add
        </Button>
      </form>
    </Page>
  );
}
