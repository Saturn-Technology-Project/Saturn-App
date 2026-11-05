import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { changedSince, lastActive, reviewProgress, runHasResults, runStatusLabel, type Hypothesis, type Verdict } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;
const VERDICTS: Verdict[] = ["undecided", "supported", "refuted", "inconclusive"];

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
      {active ? <div className="lab-muted">Last active {when(active)}</div> : null}
      <div className="lab-form" style={{ marginTop: 14 }}>
        <button type="button" className="lab-button primary" onClick={() => props.go("Workspace")}>
          {restored.length ? "Restore last layout" : "Continue in the workspace"}
        </button>
        {value?.lastWithResults ? (
          <button type="button" className="lab-button" onClick={() => { service.open(projectId, { kind: "sample", runId: value.lastWithResults!.id }); props.go("Samples"); }}>
            Continue sample review{value.review ? ` (${value.review.labeled} of ${value.review.total})` : ""}
          </button>
        ) : null}
      </div>

      {restored.length ? (
        <>
          <h2>Restored as it was</h2>
          <div className="lab-card">
            <div>The workspace reopens with {restored.join(", ")}.</div>
            <div className="lab-muted">Records come from the project folder; what was open comes from this device.</div>
          </div>
        </>
      ) : null}

      <h2>Since your last visit</h2>
      {visited ? <div className="lab-muted">On this device, {when(visited)}.</div> : <div className="lab-muted">First visit on this device, so everything is new.</div>}
      {since.length === 0 ? <p className="lab-muted">Nothing changed.</p> : null}
      {since.slice(0, 8).map((item) => (
        <div className="lab-row" key={item.key}>
          <span>{item.text}</span>
          <button type="button" className="lab-link" onClick={() => props.go(item.screen)}>
            {item.screen === "Protection" ? "Decide" : "See"}
          </button>
        </div>
      ))}

      <h2>Open</h2>
      <div className="lab-card">
        <div className="lab-row">
          <span>Latest run</span>
          <span className="lab-muted">{lastRun ? `${runStatusLabel(lastRun.status)}, ${lastRun.samples ?? 0} samples, ${when(lastRun.updatedAt)}` : "None yet"}</span>
        </div>
        {undecided.map((item) => (
          <div className="lab-row" key={item.id}>
            <span>{item.title}</span>
            <span className="lab-muted">Undecided</span>
          </div>
        ))}
        {troubled.map((run) => (
          <div className="lab-row" key={run.id}>
            <span>Run {run.id}</span>
            <span className="lab-muted">{runStatusLabel(run.status)}</span>
          </div>
        ))}
        <div className="lab-row">
          <span>Refusals and unexplained changes</span>
          {alerts.length ? (
            <button type="button" className="lab-link" onClick={() => props.go("Protection")}>
              {alerts.length} to look at
            </button>
          ) : (
            <span className="lab-muted">None</span>
          )}
        </div>
      </div>

      <h2 data-tour="home-questions">Questions</h2>
      {value?.questions.map((item) => (
        <div className="lab-row" key={item.id}>
          <span>{item.title}</span>
        </div>
      ))}
      <form
        className="lab-form"
        style={{ marginTop: 8 }}
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
        <label className="lab-field">
          New question
          <input value={question} onChange={(event) => setQuestion(event.target.value)} />
        </label>
        <button type="submit" className="lab-button" disabled={!question.trim()}>
          Add
        </button>
      </form>

      <h2 data-tour="home-hypotheses">Hypotheses</h2>
      <p className="lab-lead">A verdict is yours to set. A run that completes says only that it executed.</p>
      {value?.hypotheses.map((item: Hypothesis) => (
        <div className="lab-row" key={item.id}>
          <span>{item.title}</span>
          <label className="lab-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            Verdict
            <select value={item.verdict} onChange={(event) => void act(() => service.setVerdict(projectId, item, event.target.value as Verdict))}>
              {VERDICTS.map((verdict) => (
                <option key={verdict} value={verdict}>
                  {verdict[0].toUpperCase() + verdict.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ))}
      <form
        className="lab-form"
        style={{ marginTop: 8 }}
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
        <label className="lab-field">
          New hypothesis
          <input value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} />
        </label>
        <button type="submit" className="lab-button" disabled={!hypothesis.trim()}>
          Add
        </button>
      </form>
    </Page>
  );
}
