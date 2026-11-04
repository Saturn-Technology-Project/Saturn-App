import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  comparisonText,
  runStatusLabel,
  sampleText,
  type AcrossRow,
  type ExperimentRun,
  type RunLabels,
  type SampleItem,
} from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;
const LABELS = ["Correct", "Wrong", "Invalid", "Unsure"];

/** One sample across runs, and a person's label on it, which never overwrites a score. */
export function Samples(props: ScreenProps & { onReview: (item: SampleItem | null) => void }) {
  const projectId = props.project.id;
  const { value } = useRecords(async () => (await service.runs(projectId)).items as ExperimentRun[], props.notify);
  const runs = value ?? [];
  const [chosen, setChosen] = useState<string[]>([]);
  const [sampleId, setSampleId] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  const [rows, setRows] = useState<AcrossRow[] | null>(null);
  const [labels, setLabels] = useState<Record<string, RunLabels>>({});
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  async function toggleRun(run: string) {
    const next = chosen.includes(run) ? chosen.filter((item) => item !== run) : [...chosen, run];
    setChosen(next);
    setRows(null);
    if (next.length && !known.length) {
      try {
        const page = await service.samples(projectId, next[0]);
        setKnown(page.items.flatMap((item) => (item.sample ? [item.sample.sampleId] : [])));
      } catch (error) {
        props.notify(messageOf(error));
      }
    }
  }

  async function show(sample = sampleId) {
    if (!sample.trim() || !chosen.length) return;
    try {
      setSampleId(sample);
      setSaved(null);
      const across = (await service.sampleAcross(projectId, sample.trim(), chosen)).rows;
      setRows(across);
      const shown = across.flatMap((row) => row.samples)[0];
      props.onReview(shown ? { offset: 0, sample: shown } : null);
      const loaded: Record<string, RunLabels> = {};
      for (const run of chosen) loaded[run] = await service.labels(projectId, run);
      setLabels(loaded);
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  async function label(run: string, line: AcrossRow["samples"][number], value: string) {
    try {
      await service.setLabel(projectId, run, line, value);
      setLabels({ ...labels, [run]: await service.labels(projectId, run) });
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  const labelOf = (run: string, line: AcrossRow["samples"][number]) =>
    Object.values(labels[run]?.labels ?? {}).find((item) => item.sampleId === line.sampleId && item.trial === (line.trial ?? 0) && (item.modelId ?? null) === (line.modelId ?? null))?.label;

  return (
    <div className="lab-page"><div className="lab-page-inner">
      <h1>Samples across runs</h1>
      <p className="lab-lead">Model output is data. It is shown as plain text and never read as instructions. A label never overwrites a score.</p>
      <h2>Runs</h2>
      {runs.map((run) => (
        <label className="lab-row" key={run.id}>
          <span><code>{run.id}</code> <span className="lab-muted">{runStatusLabel(run.status)}</span></span>
          <input type="checkbox" checked={chosen.includes(run.id)} onChange={() => void toggleRun(run.id)} />
        </label>
      ))}
      {runs.length === 0 ? <p className="lab-muted">No runs yet.</p> : null}
      <form
        className="lab-form"
        onSubmit={(event) => {
          event.preventDefault();
          void show();
        }}
      >
        <label className="lab-field">
          <span>Sample</span>
          <input list="research-known-samples" value={sampleId} onChange={(event) => setSampleId(event.target.value)} spellCheck={false} />
          <datalist id="research-known-samples">
            {known.map((item) => <option key={item} value={item} />)}
          </datalist>
        </label>
        <button type="submit" className="lab-button" disabled={!sampleId.trim() || !chosen.length}>
          Show
        </button>
      </form>

      {rows ? (
        <>
          <h2>{sampleId}</h2>
          <div className="lab-table-wrap">
            <table className="lab-table">
              <thead>
                <tr><th scope="col">Run</th><th scope="col">Compared with the first</th><th scope="col">Output</th><th scope="col">Scores</th><th scope="col">Your label</th></tr>
              </thead>
              <tbody>
                {rows.map((row) =>
                  row.samples.length === 0 ? (
                    <tr key={row.runId}><td><code>{row.runId}</code></td><td colSpan={4} className="lab-muted">This run has no such sample.</td></tr>
                  ) : (
                    row.samples.map((line) => (
                      <tr key={`${row.runId}-${line.trial ?? 0}-${line.modelId ?? ""}`}>
                        <td><code>{row.runId}</code>{row.models?.length ? <div className="lab-muted">{row.models.map((model) => `${model.role}: ${model.source}`).join(", ")}</div> : null}</td>
                        <td className={row.comparison.result === "comparable" ? "lab-muted" : "lab-warning"}>{comparisonText(row.comparison)}</td>
                        <td><pre className="lab-text">{sampleText(line.output)}</pre></td>
                        <td><pre className="lab-text">{sampleText(line.scores)}</pre>{line.error ? <div className="lab-warning">{line.error.kind} error</div> : null}</td>
                        <td>
                          <select aria-label={`Your label for ${row.runId}`} value={labelOf(row.runId, line) ?? ""} onChange={(event) => void label(row.runId, line, event.target.value)}>
                            <option value="" disabled>Choose</option>
                            {LABELS.map((item) => <option key={item} value={item}>{item}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))
                  ),
                )}
              </tbody>
            </table>
          </div>
          {chosen.map((run) => labels[run]).filter(Boolean).slice(0, 1).map((item) => (
            <p key="agreement" className="lab-muted">
              First run: {item.agreement.labeled} labeled, {item.agreement.agreed} of {item.agreement.compared} that the scorer labeled agree with it.
            </p>
          ))}
          <div className="lab-form">
            <label className="lab-field">
              <span>Why keep this sample</span>
              <input value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <button
              type="button"
              className="lab-button"
              onClick={() => {
                void service
                  .addCounterexample(projectId, chosen[0], sampleId.trim(), note)
                  .then(() => {
                    setNote("");
                    setSaved("Saved as a counterexample.");
                  })
                  .catch((error: unknown) => props.notify(messageOf(error)));
              }}
            >
              Save as counterexample
            </button>
            {saved ? <span className="lab-muted">{saved}</span> : null}
          </div>
        </>
      ) : null}
    </div></div>
  );
}

