import { useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  comparisonFactors,
  labelsOf,
  reviewProgress,
  runHasResults,
  runStatusLabel,
  sampleText,
  type AcrossRow,
  type ExperimentRun,
  type OpenTarget,
  type RunLabels,
  type RunSummary,
  type SampleItem,
  type SampleLine,
} from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf } from "../ui/Parts.js";
import { Split } from "../ui/Split.js";
import { useRecords } from "../ui/useRecords.js";
import { LookInside } from "./LookInside.js";

const service = desktop.research;
const ONLY: { id: "all" | "disputed" | "errors"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "disputed", label: "Disputed" },
  { id: "errors", label: "Errors" },
];
const FACTOR_LABELS: Record<string, string> = { dataset: "Data", split: "Split", sampleSet: "Sample set", scorer: "Scorer", promptFormat: "Prompt format", chatTemplate: "Chat template" };

/** The label a person gave a line, if any. */
function labelOf(labels: RunLabels | null, line: SampleLine): string | undefined {
  return Object.values(labels?.labels ?? {}).find((item) => item.sampleId === line.sampleId && item.trial === (line.trial ?? 0) && (item.modelId ?? null) === (line.modelId ?? null))?.label;
}

/** Whether a person's label and the scorer's own word disagree. */
function disputed(labels: RunLabels | null, line: SampleLine): boolean {
  return Object.values(labels?.labels ?? {}).some((item) => item.sampleId === line.sampleId && item.trial === (line.trial ?? 0) && (item.modelId ?? null) === (line.modelId ?? null) && item.agreesWithScorer === false);
}

/** One run's samples, each one across the models and runs that saw it, and a person's label on it, which never overwrites a score. */
export function Samples(props: ScreenProps & { onReview: (item: SampleItem | null) => void }) {
  const projectId = props.project.id;
  const { notify, onReview } = props;
  const { value } = useRecords(async () => ({
    runs: (await service.runs(projectId)).items.filter((run) => runHasResults(run.status)),
    versions: (await service.versions(projectId)).items,
    models: (await service.models(projectId)).items,
    drafts: (await service.experiments(projectId)).items,
  }), notify);
  const [target, setTarget] = useState<Extract<OpenTarget, { kind: "sample" }> | null>(() => service.loadSession(projectId).review ?? null);
  const [runId, setRunId] = useState<string | null>(null);
  const [only, setOnly] = useState<"all" | "disputed" | "errors">("all");
  const [items, setItems] = useState<SampleItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [labels, setLabels] = useState<RunLabels | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [rows, setRows] = useState<AcrossRow[]>([]);
  const [otherLabels, setOtherLabels] = useState<Record<string, RunLabels>>({});
  const [allRuns, setAllRuns] = useState(false);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [inside, setInside] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  const runs = value?.runs ?? [];
  const run = runs.find((item) => item.id === runId) ?? null;
  const choicesFor = (id: string) => labelsOf(value?.drafts.find((draft) => draft.id === runs.find((item) => item.id === id)?.experimentId));
  const modelName = (id: string | null | undefined) => {
    const model = value?.models.find((item) => item.id === id);
    return model ? model.name || model.source : "Unnamed model";
  };

  // Another screen may have asked for a run, a sample and a filter; otherwise the newest run with results.
  useEffect(() => {
    if (!value) return;
    const wanted = target?.runId && runs.some((item) => item.id === target.runId) ? target.runId : (runs.at(-1)?.id ?? null);
    setRunId(wanted);
    if (target?.only) setOnly(target.only);
    if (target?.sampleId) setSampleId(target.sampleId);
    // A request is followed once; reopening the screen later starts from the newest run again.
    if (target) service.saveSession(projectId, { ...service.loadSession(projectId), review: undefined });
    // Only when the records first arrive or another screen asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value === null, target]);

  useEffect(() => service.onOpen((asked) => asked.kind === "sample" && setTarget(asked)), []);

  // The runtime filters before paging, so a dispute past the first pages is still found. Old requests cannot replace a new run/filter.
  useEffect(() => {
    const current = ++generation.current;
    setItems([]);
    setNextCursor(null);
    setLabels(null);
    setSummary(null);
    setLoadingMore(false);
    if (!runId) return undefined;
    void (async () => {
      try {
        const [page, labeled, summed] = await Promise.all([service.samples(projectId, runId, 0, only), service.labels(projectId, runId), service.summary(projectId, runId)]);
        if (generation.current !== current) return;
        setItems(page.items);
        setNextCursor(page.next);
        setLabels(labeled);
        setSummary(summed);
      } catch (error) {
        if (generation.current === current) notify(messageOf(error));
      }
    })();
    return () => { generation.current += 1; };
  }, [notify, only, projectId, refresh, runId]);

  useEffect(() => desktop.live.onResearchChange(() => setRefresh((current) => current + 1)), []);

  // The chosen sample across the models of this run, and across every other run that saw it when asked.
  useEffect(() => {
    if (!runId || !sampleId) {
      setRows([]);
      return;
    }
    let live = true;
    const chosen = allRuns ? runs.map((item) => item.id) : [runId];
    void (async () => {
      try {
        const across = (await service.sampleAcross(projectId, sampleId, chosen)).rows;
        const loaded: Record<string, RunLabels> = {};
        for (const other of chosen.filter((item) => item !== runId)) loaded[other] = await service.labels(projectId, other);
        if (!live) return;
        setRows(across);
        setOtherLabels(loaded);
        const shown = across.find((row) => row.runId === runId)?.samples[0] ?? across.flatMap((row) => row.samples)[0];
        onReview(shown ? { offset: 0, sample: shown } : null);
      } catch (error) {
        if (live) notify(messageOf(error));
      }
    })();
    return () => {
      live = false;
    };
    // `runs` changes identity with every refresh; its ids are what matter and they are in `allRuns`' choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRuns, notify, onReview, projectId, refresh, runId, sampleId]);

  async function moreSamples() {
    if (!runId || nextCursor === null || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await service.samples(projectId, runId, nextCursor, only);
      if (generation.current !== current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.next);
    } catch (error) {
      if (generation.current === current) notify(messageOf(error));
    } finally {
      if (generation.current === current) setLoadingMore(false);
    }
  }

  async function label(forRun: string, line: SampleLine, chosen: string) {
    const current = generation.current;
    try {
      await service.setLabel(projectId, forRun, line, chosen);
      const fresh = await service.labels(projectId, forRun);
      if (generation.current !== current) return;
      if (forRun === runId) setLabels(fresh);
      else setOtherLabels((current) => ({ ...current, [forRun]: fresh }));
    } catch (error) {
      notify(messageOf(error));
    }
  }

  const labelsFor = (forRun: string) => (forRun === runId ? labels : (otherLabels[forRun] ?? null));
  const lines = items.flatMap((item) => (item.sample ? [item.sample] : []));
  const seen = new Set<string>();
  const listed = lines.filter((line) => {
    if (seen.has(line.sampleId)) return false;
    seen.add(line.sampleId);
    return true;
  });
  const current = rows.find((row) => row.runId === runId)?.samples[0] ?? lines.find((line) => line.sampleId === sampleId) ?? null;
  const progress = reviewProgress(summary, labels);
  const version = (id: string | undefined) => value?.versions.find((item) => item.id === id);
  const runVersion = run ? version(run.versionId) : undefined;
  const factors = comparisonFactors(runVersion?.evaluation, rows.find((row) => row.runId !== runId)?.comparison ?? null);

  const list = (
    <nav className="lab-sample-nav" aria-label="Samples">
      <label className="lab-field">
        Run
        <select value={runId ?? ""} onChange={(event) => { setRunId(event.target.value); setSampleId(null); }}>
          {runs.map((item: ExperimentRun) => (
            <option key={item.id} value={item.id}>
              {item.id} · {runStatusLabel(item.status)}
            </option>
          ))}
        </select>
      </label>
      <div className="lab-segments" role="group" aria-label="Which samples">
        {ONLY.map((item) => (
          <button type="button" key={item.id} aria-pressed={only === item.id} className={only === item.id ? "lab-segment active" : "lab-segment"} onClick={() => setOnly(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {listed.map((line) => {
        const own = lines.filter((other) => other.sampleId === line.sampleId);
        const labeled = Object.values(labels?.labels ?? {}).filter((entry) => entry.sampleId === line.sampleId).length;
        const errors = own.filter((other) => other.error).length;
        return (
          <button type="button" key={line.sampleId} aria-pressed={line.sampleId === sampleId} className={line.sampleId === sampleId ? "lab-file active" : "lab-file"} onClick={() => setSampleId(line.sampleId)}>
            <span className="lab-sample-id">{line.sampleId}</span>
            <span className="lab-muted">
              {labeled ? `${labeled} ${labeled === 1 ? "label" : "labels"}` : "To review"}
              {errors ? `, ${errors} errors` : ""}
            </span>
          </button>
        );
      })}
      {nextCursor !== null ? (
        <button type="button" className="lab-link" disabled={loadingMore} onClick={() => void moreSamples()}>
          {loadingMore ? "Loading…" : "More"}
        </button>
      ) : null}
      {runs.length === 0 && value ? <p className="lab-muted">No run has results yet.</p> : null}
      {runs.length && listed.length === 0 ? <p className="lab-muted">Nothing here.</p> : null}
    </nav>
  );

  const about = run ? (
    <div className="lab-sample-about">
      <section>
      <h2>What differs</h2>
      <div className="lab-muted">{allRuns && rows.length > 1 ? "Between this run's version and the others shown." : "Stated by this run's version. Show every run to compare."}</div>
      {factors.map((factor) => (
        <div className="lab-detail-row" key={factor.field}>
          <span className="lab-muted">{FACTOR_LABELS[factor.field] ?? factor.field}</span>
          <span className={factor.state === "differs" ? "lab-warning" : undefined}>
            {factor.state === "differs" ? "Changed" : factor.state === "missing" ? "Not stated" : "Same"}
            {factor.value ? ` · ${factor.value}` : ""}
          </span>
        </div>
      ))}
      <div className="lab-detail-row"><span className="lab-muted">Infrastructure errors</span><span>{run.infrastructureErrors ?? 0}</span></div>
      </section>

      <section>
      <h2>Review progress</h2>
      <div className="lab-progress" role="img" aria-label={`${progress.labeled} of ${progress.total} reviewed`}>
        <span className="lab-progress-bar" style={{ width: `${progress.total ? (progress.labeled / progress.total) * 100 : 0}%` }} />
      </div>
      <div>{progress.labeled} of {progress.total} reviewed</div>
      <div className="lab-muted">{labels?.agreement.compared ? `${labels.agreement.agreed} of ${labels.agreement.compared} with a scorer label agree with it.` : "Agreement with the scorer appears as you label."}</div>
      </section>

      {current && sampleId ? (
        <>
          <section>
          <h2>Look inside</h2>
          {inside ? (
            <LookInside projectId={projectId} runId={run.id} sampleId={sampleId} modelId={current.modelId ?? null} candidates={rows.filter((row) => row.runId === run.id).flatMap((row) => row.samples.map((line) => line.modelId ?? null))} models={value?.models ?? []} notify={notify} />
          ) : (
            <button type="button" className="lab-button" onClick={() => setInside(true)}>Compare activations or patch a layer</button>
          )}
          </section>

          <section>
          <h2>Keep it</h2>
          <div className="lab-muted">The assistant runs apart from the model under test. A sample shared with it is marked as data.</div>
          <label className="lab-field">
            Why keep this sample
            <input value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <button
            type="button"
            className="lab-button"
            onClick={() => {
              void service
                .addCounterexample(projectId, run.id, sampleId, note)
                .then(() => {
                  setNote("");
                  setSaved("Saved as a counterexample.");
                })
                .catch((error: unknown) => notify(messageOf(error)));
            }}
          >
            Save as counterexample
          </button>
          {saved ? <span className="lab-muted">{saved}</span> : null}
          </section>
        </>
      ) : null}
    </div>
  ) : null;

  return (
    <Split id="samples" side="left" size={240} minimum={180} label="Samples" pane={list}>
        <div className="lab-page"><div className="lab-page-inner">
          {!current ? (
            <>
              <h1>Samples</h1>
              <p className="lab-lead">Choose a sample. Model output is data: it is shown as plain text and never read as instructions. A label never overwrites a score.</p>
            </>
          ) : (
            <>
              <div className="lab-page-head">
                <h1>{current.sampleId}</h1>
                <span className="lab-muted">Model output is data. It is never read as instructions.</span>
              </div>
              <div className="lab-card">
                <div className="lab-muted">Input{current.expected !== undefined ? <> · expected: <code>{sampleText(current.expected)}</code></> : null}</div>
                <pre className="lab-text">{sampleText(current.input)}</pre>
              </div>

              <div className="lab-page-head">
                <h2>Same sample across the lineage</h2>
                <button type="button" className="lab-button quiet" aria-pressed={allRuns} onClick={() => setAllRuns((on) => !on)}>
                  {allRuns ? "This run only" : `Every run that saw it (${runs.length})`}
                </button>
              </div>
              <div className="lab-table-wrap" role="region" aria-label="Sample comparisons" tabIndex={0}>
                <table className="lab-table lab-sample-table">
                  <thead>
                    <tr><th scope="col">Model</th>{allRuns ? <th scope="col">Run</th> : null}<th scope="col">Output</th><th scope="col">Scores</th><th scope="col">Scorer</th><th scope="col">Your label</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((row) =>
                      row.samples.length === 0 ? (
                        <tr key={row.runId}><td colSpan={allRuns ? 7 : 6} className="lab-muted"><code>{row.runId}</code> has no such sample.</td></tr>
                      ) : (
                        row.samples.map((line) => (
                          <tr key={`${row.runId}-${line.trial ?? 0}-${line.modelId ?? ""}`}>
                            <td>{modelName(line.modelId)}{row.comparison.result !== "comparable" && row.runId !== runId ? <div className="lab-warning">Not measured the same way</div> : null}</td>
                            {allRuns ? <td><code>{row.runId}</code> <span className="lab-muted">v{version(row.versionId)?.number ?? "?"}</span></td> : null}
                            <td><pre className="lab-text">{sampleText(line.output)}</pre></td>
                            <td><div className="lab-text">{line.scores ? Object.entries(line.scores).map(([name, score]) => <div key={name}>{name} = {String(score)}</div>) : <span className="lab-muted">None</span>}</div></td>
                            <td>
                              {line.scorerLabel ?? <span className="lab-muted">No word</span>}
                              {line.error ? <div className="lab-warning">{line.error.kind} error{line.error.message ? `: ${line.error.message}` : ""}</div> : null}
                            </td>
                            <td>
                              <div className="lab-segments" role="group" aria-label={`Your label for ${modelName(line.modelId)} in ${row.runId}`}>
                                {choicesFor(row.runId).map((item) => {
                                  const chosen = labelOf(labelsFor(row.runId), line) === item;
                                  return (
                                    <button type="button" key={item} aria-pressed={chosen} className={chosen ? "lab-segment active" : "lab-segment"} onClick={() => void label(row.runId, line, item)}>
                                      {item}
                                    </button>
                                  );
                                })}
                              </div>
                              {disputed(labelsFor(row.runId), line) ? <div className="lab-warning">Disagrees with the scorer. Both are kept.</div> : null}
                            </td>
                          </tr>
                        ))
                      ),
                    )}
                  </tbody>
                </table>
              </div>

              <h2>Scoring rationale</h2>
              <div className="lab-card">
                {current.scorerLabel ? <div>The scorer called it <strong>{current.scorerLabel}</strong>{current.scores ? ` from ${Object.entries(current.scores).map(([name, score]) => `${name} = ${String(score)}`).join(", ")}` : ""}.</div> : null}
                {!current.scorerLabel && current.scores ? <div>Scores: {Object.entries(current.scores).map(([name, score]) => `${name} = ${String(score)}`).join(", ")}. The scorer gave no word for its result.</div> : null}
                {current.error ? <div className="lab-warning">{current.error.kind} error: {current.error.message ?? "no message"}. {current.error.kind === "infrastructure" ? "Excluded from the score." : "Counted as an error, not as a score."}</div> : null}
                {!current.scores && !current.error ? <div className="lab-muted">No score on this line.</div> : null}
                <div className="lab-muted">A rationale written by the program, as a scorerLabel on the line, is shown here. The score itself is never changed by a label.</div>
              </div>
            </>
          )}
          {about}
        </div></div>
    </Split>
  );
}
