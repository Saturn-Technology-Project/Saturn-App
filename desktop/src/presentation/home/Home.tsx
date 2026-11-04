import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { runStatusLabel, type Hypothesis, type Verdict } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;
const VERDICTS: Verdict[] = ["undecided", "supported", "refuted", "inconclusive"];

/** A day in words, for saying when the work stopped. */
function when(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

/** Where the work stopped: the newest note and run, what changed since, and what is still open. */
export function Home(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(
    async () => ({
      questions: (await service.questions(projectId)).items,
      hypotheses: (await service.hypotheses(projectId)).items,
      runs: (await service.runs(projectId)).items,
      findings: (await service.findings(projectId)).items,
      events: (await service.events(projectId)).items,
    }),
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

  return (
    <Page title={lastQuestion ? lastQuestion.title : `Start ${props.project.name}`} lead={lastFinding ? `Latest note: ${lastFinding.text}` : "Write down the question this project is trying to answer, then work on it."}>
      <div className="lab-form" style={{ marginTop: 14 }}>
        <button type="button" className="lab-button primary" onClick={() => props.go("Workspace")}>
          Continue in the workspace
        </button>
        {lastRun ? (
          <button type="button" className="lab-button" onClick={() => props.go("Samples")}>
            Review samples
          </button>
        ) : null}
      </div>

      <h2>Where it stands</h2>
      <div className="lab-card">
        <div className="lab-row">
          <span>Latest run</span>
          <span className="lab-muted">{lastRun ? `${runStatusLabel(lastRun.status)}, ${lastRun.samples ?? 0} samples, ${when(lastRun.updatedAt)}` : "None yet"}</span>
        </div>
        <div className="lab-row">
          <span>Undecided hypotheses</span>
          <span className="lab-muted">{undecided.length}</span>
        </div>
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

      <h2>Questions</h2>
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

      <h2>Hypotheses</h2>
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
