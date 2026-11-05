import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  comparisonText,
  DEFAULT_LABELS,
  EVALUATION_FIELD_NAMES,
  runHasResults,
  runStatusLabel,
  scoreSources,
  type Comparison,
  type ExperimentDraft,
  type ExperimentRun,
  type Finding,
  type FindingKind,
  type FrozenVersion,
  type Hypothesis,
  type ModelNode,
  type ModelRole,
  type Question,
  type RunLabels,
  type RunSummary,
  type Verdict,
} from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

import { Mechanism } from "./Mechanism.js";
import { ScoreChart } from "./ScoreChart.js";

const service = desktop.research;
const FIELD_LABELS: Record<(typeof EVALUATION_FIELD_NAMES)[number], string> = {
  dataset: "Dataset",
  split: "Split",
  sampleSet: "Sample set",
  scorer: "Scorer",
  promptFormat: "Prompt format",
  chatTemplate: "Chat template (empty for none)",
};
const FINDING_LABELS: Record<FindingKind, string> = { observation: "Observation", ai_suggestion: "AI suggestion", conclusion: "Conclusion" };
const VERDICTS: Verdict[] = ["undecided", "supported", "refuted", "inconclusive"];

/** What an experiment measures, its frozen versions and runs, where its score comes from, and what was concluded. */
export function Experiments(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(async () => ({
    drafts: (await service.experiments(projectId)).items,
    versions: (await service.versions(projectId)).items,
    runs: (await service.runs(projectId)).items,
    models: (await service.models(projectId)).items,
    questions: (await service.questions(projectId)).items,
    hypotheses: (await service.hypotheses(projectId)).items,
    findings: (await service.findings(projectId)).items,
  }), props.notify);
  const [selected, setSelected] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [binding, setBinding] = useState<{ modelId: string; role: ModelRole }>({ modelId: "", role: "base" });
  const [compared, setCompared] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [conclusion, setConclusion] = useState("");
  const [exported, setExported] = useState<string | null>(null);
  const drafts = value?.drafts ?? [];
  const draft = drafts.find((item) => item.id === selected) ?? drafts[drafts.length - 1];
  const spec = draft?.evaluation ?? {};
  const bound = draft?.models ?? [];
  const versions = (value?.versions ?? []).filter((item) => item.experimentId === draft?.id);
  const runs = (value?.runs ?? []).filter((item) => item.experimentId === draft?.id);
  const finished = runs.filter((run) => runHasResults(run.status));
  const newest = finished.at(-1) ?? null;
  const question = value?.questions.find((item) => item.id === draft?.questionId);
  const hypothesis = value?.hypotheses.find((item) => item.id === draft?.hypothesisId);
  const findings = (value?.findings ?? []).filter((item) => item.runIds?.some((id) => runs.some((run) => run.id === id)));
  const results = useResults(projectId, finished, newest, props.notify);

  async function change(fields: Partial<ExperimentDraft>) {
    if (!draft) return;
    try {
      await service.updateExperiment(projectId, draft, fields);
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  async function saveEvaluation() {
    // An empty chat template field states that there is none, which is different from not saying.
    const evaluation: Record<string, unknown> = { generation: {}, chatTemplate: null, ...spec };
    for (const key of EVALUATION_FIELD_NAMES) {
      if (key in edits) evaluation[key] = edits[key] === "" && key === "chatTemplate" ? null : edits[key];
    }
    const labels = "labels" in edits ? edits.labels.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
    await change({ evaluation, models: bound, ...(labels === undefined ? {} : { labels }) });
    setEdits({});
  }

  async function bindModel() {
    if (!binding.modelId) return;
    await change({ models: [...bound, binding] });
    setBinding({ modelId: "", role: "base" });
  }

  async function toggleCompared(version: string) {
    const next = compared.includes(version) ? compared.filter((item) => item !== version) : [...compared, version].slice(-2);
    setCompared(next);
    setComparison(null);
    if (next.length === 2) {
      try {
        setComparison(await service.compare(projectId, next[0], next[1]));
      } catch (error) {
        props.notify(messageOf(error));
      }
    }
  }

  async function freeze() {
    if (!draft) return;
    try {
      const version = await service.freeze(projectId, draft.id);
      props.notify(`Version ${version.number} frozen. The next run uses it.`);
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  async function conclude() {
    if (!conclusion.trim()) return;
    try {
      await service.addFinding(projectId, conclusion.trim(), "conclusion", newest ? [newest.id] : []);
      setConclusion("");
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  /** Writes the experiment's record as one JSON file in the project, so it can leave with the project. */
  async function exportRecord() {
    if (!draft) return;
    const path = `exports/${draft.id}-${new Date().toISOString().slice(0, 10)}.json`;
    const record = {
      experiment: draft,
      question: question ?? null,
      hypothesis: hypothesis ?? null,
      versions,
      runs,
      summaries: results.summaries,
      findings,
      models: bound.map((item) => value?.models.find((model) => model.id === item.modelId) ?? item),
    };
    try {
      await service.exportFile(projectId, path, JSON.stringify(record, null, 2) + "\n");
      setExported(path);
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  const summary = newest ? results.summaries.find((item) => item.runId === newest.id) ?? null : null;
  const sources = summary ? scoreSources(summary, results.labels) : null;
  const toSamples = (only: "disputed" | "errors" | "all") => {
    if (!newest) return;
    service.open(projectId, { kind: "sample", runId: newest.id, only });
    props.go("Samples");
  };

  return (
    <div className="lab-page"><div className="lab-page-inner">
      <div className="lab-page-head">
        <h1>Experiments</h1>
        {draft ? (
          <div className="lab-page-actions">
            <button type="button" className="lab-button" onClick={() => void exportRecord()}>Export</button>
            <button type="button" className="lab-button primary" onClick={() => void freeze()}>New version</button>
          </div>
        ) : null}
      </div>
      {exported ? <div className="lab-notice">Written to {exported} in the project.</div> : null}
      {drafts.length === 0 ? <p className="lab-lead">Running a command in the workspace creates the first experiment.</p> : null}
      {drafts.length > 1 ? drafts.map((item) => (
        <button type="button" key={item.id} aria-pressed={item.id === draft?.id} className={item.id === draft?.id ? "lab-list-item active" : "lab-list-item"} onClick={() => setSelected(item.id)}>
          <strong>{item.title}</strong> <code className="lab-muted">{item.command}</code>
        </button>
      )) : null}
      {draft ? (
        <>
          <div className="lab-stats">
            <label className="lab-stat">
              <span className="lab-muted">Question</span>
              <select value={draft.questionId ?? ""} onChange={(event) => void change({ questionId: event.target.value || undefined })}>
                <option value="">Not set</option>
                {value?.questions.map((item: Question) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
            <label className="lab-stat">
              <span className="lab-muted">Hypothesis</span>
              <select value={draft.hypothesisId ?? ""} onChange={(event) => void change({ hypothesisId: event.target.value || undefined })}>
                <option value="">Not set</option>
                {value?.hypotheses.map((item: Hypothesis) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
            <div className="lab-stat current"><span className="lab-muted">Experiment</span><strong>{versions.length ? `v${versions.at(-1)?.number} frozen` : "Not frozen yet"}</strong></div>
            <div className="lab-stat"><span className="lab-muted">Runs</span><strong>{runs.length}</strong></div>
            <div className="lab-stat"><span className="lab-muted">Evidence</span><strong>{sources ? `${sources.scored} samples` : "None yet"}</strong></div>
            <div className="lab-stat"><span className="lab-muted">Findings</span><strong>{findings.length ? `${findings.length}, ${findings.some((item) => item.kind === "conclusion") ? "concluded" : "no conclusion"}` : "None"}</strong></div>
          </div>

          <div className="lab-cards">
            <div className="lab-card">
              <div className="lab-muted">Execution</div>
              <strong className="lab-card-headline">{newest ? runStatusLabel(newest.status) : runs.length ? runStatusLabel(runs.at(-1)!.status) : "Not run"}</strong>
              <div className="lab-muted">{finished.length} of {runs.length} runs have results. Execution says nothing about whether the hypothesis holds.</div>
            </div>
            <div className={hypothesis?.verdict === "undecided" ? "lab-card attention" : "lab-card"}>
              <div className="lab-muted">{hypothesis ? `Hypothesis` : "Hypothesis"}</div>
              {hypothesis ? (
                <>
                  <strong className="lab-card-headline">{hypothesis.verdict[0].toUpperCase() + hypothesis.verdict.slice(1)}</strong>
                  <div className="lab-muted">{hypothesis.title}</div>
                  <label className="lab-field" style={{ maxWidth: 220 }}>
                    Only you set this
                    <select value={hypothesis.verdict} onChange={(event) => void service.setVerdict(projectId, hypothesis, event.target.value as Verdict).then(refresh).catch((error: unknown) => props.notify(messageOf(error)))}>
                      {VERDICTS.map((verdict) => <option key={verdict} value={verdict}>{verdict[0].toUpperCase() + verdict.slice(1)}</option>)}
                    </select>
                  </label>
                </>
              ) : (
                <div className="lab-muted">Choose the hypothesis this experiment tests, above.</div>
              )}
            </div>
          </div>

          <ScoreChart projectId={projectId} runs={finished} versions={versions} models={value?.models ?? []} summaries={results.summaries} comparisons={results.comparisons} />

          {sources && newest ? (
            <>
              <h2>Where the score comes from</h2>
              <p className="lab-lead">The newest run with results, {newest.id}.</p>
              <div className="lab-cards">
                <button type="button" className="lab-card lab-card-button" onClick={() => toSamples("all")}>
                  <strong>Model behavior</strong>
                  <span className="lab-muted">{sources.scored} samples the scorer judged</span>
                </button>
                <button type="button" className={sources.disputed ? "lab-card lab-card-button attention" : "lab-card lab-card-button"} onClick={() => toSamples("disputed")}>
                  <strong>Scorer in question</strong>
                  <span className="lab-muted">{sources.reviewed ? `${sources.disputed} of ${sources.reviewed} reviewed disagree with the scorer` : "Nothing reviewed yet"}</span>
                </button>
                <button type="button" className="lab-card lab-card-button" onClick={() => toSamples("errors")}>
                  <strong>Errors</strong>
                  <span className="lab-muted">{sources.infrastructure} infrastructure, excluded{sources.otherErrors ? `; ${sources.otherErrors} model or scorer` : ""}</span>
                </button>
              </div>
            </>
          ) : null}

          <h2>Does the mechanism change too?</h2>
          <Mechanism
            projectId={projectId}
            run={newest}
            summary={summary}
            models={value?.models ?? []}
            notify={props.notify}
            onRecord={async (text) => {
              try {
                await service.addFinding(projectId, text, "observation", newest ? [newest.id] : []);
                await refresh();
              } catch (error) {
                props.notify(messageOf(error));
              }
            }}
          />

          <h2>Findings</h2>
          <div className="lab-chips">
            {findings.length === 0 ? <span className="lab-muted">None linked to this experiment's runs yet.</span> : null}
            {findings.map((finding: Finding) => (
              <span key={finding.id} className={finding.kind === "ai_suggestion" ? "lab-chip marked" : "lab-chip"} title={finding.text}>
                {FINDING_LABELS[finding.kind]}{finding.kind === "ai_suggestion" ? " · marked" : finding.kind === "conclusion" ? " · yours" : ""}{finding.runIds?.[0] ? ` · ${finding.runIds[0]}` : ""}
              </span>
            ))}
          </div>
          {[...findings].reverse().slice(0, 3).map((finding) => (
            <article key={finding.id} className="lab-card">
              <div className="lab-muted">{FINDING_LABELS[finding.kind]}</div>
              <div>{finding.text}</div>
            </article>
          ))}
          <form
            className="lab-form"
            onSubmit={(event) => {
              event.preventDefault();
              void conclude();
            }}
          >
            <label className="lab-field" style={{ flex: "1 1 320px" }}>
              Conclusion
              <textarea rows={2} value={conclusion} placeholder={newest ? `Saved with run ${newest.id} and its exact conditions.` : "Saved with this experiment."} onChange={(event) => setConclusion(event.target.value)} />
            </label>
            <button type="submit" className="lab-button" disabled={!conclusion.trim()}>Save conclusion</button>
          </form>

          <h2>How it measures</h2>
          <p className="lab-lead">Two runs compare only when all of this matches. Training data is not part of it.</p>
          <div className="lab-form">
            {EVALUATION_FIELD_NAMES.map((key) => (
              <label className="lab-field" key={key}>
                <span>{FIELD_LABELS[key]}</span>
                <input value={edits[key] ?? String(spec[key] ?? "")} onChange={(event) => setEdits({ ...edits, [key]: event.target.value })} />
              </label>
            ))}
            <label className="lab-field">
              <span>Label names, comma separated</span>
              <input value={edits.labels ?? (draft.labels ?? []).join(", ")} placeholder={DEFAULT_LABELS.join(", ")} onChange={(event) => setEdits({ ...edits, labels: event.target.value })} />
            </label>
            <button type="button" className="lab-button" onClick={() => void saveEvaluation()}>
              Save
            </button>
          </div>

          <h2>Models</h2>
          {bound.map((item) => (
            <div className="lab-row" key={`${item.modelId}-${item.role}`}>
              <span>{value?.models.find((model) => model.id === item.modelId)?.name ?? value?.models.find((model) => model.id === item.modelId)?.source ?? item.modelId}</span>
              <span className="lab-muted">{item.role}</span>
            </div>
          ))}
          <div className="lab-form">
            <label className="lab-field">
              <span>Model</span>
              <select value={binding.modelId} onChange={(event) => setBinding({ ...binding, modelId: event.target.value })}>
                <option value="">Choose</option>
                {value?.models.map((model: ModelNode) => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.source}
                  </option>
                ))}
              </select>
            </label>
            <label className="lab-field">
              <span>Role</span>
              <select value={binding.role} onChange={(event) => setBinding({ ...binding, role: event.target.value as ModelRole })}>
                <option value="base">Base</option>
                <option value="reference">Reference</option>
                <option value="policy">Policy</option>
              </select>
            </label>
            <button type="button" className="lab-button" disabled={!binding.modelId} onClick={() => void bindModel()}>
              Add
            </button>
          </div>

          <h2>Frozen versions</h2>
          <div className="lab-table-wrap">
            <table className="lab-table">
              <thead>
                <tr><th scope="col">Compare</th><th scope="col">Version</th><th scope="col">Runs</th><th scope="col">Created</th></tr>
              </thead>
              <tbody>
                {versions.map((version: FrozenVersion) => (
                  <tr key={version.id}>
                    <td><input type="checkbox" aria-label={`Compare version ${version.number}`} checked={compared.includes(version.id)} onChange={() => void toggleCompared(version.id)} /></td>
                    <td>v{version.number}</td>
                    <td>{runs.filter((run) => run.versionId === version.id).length}</td>
                    <td>{new Date(version.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {comparison ? <div className={comparison.result === "comparable" ? "lab-muted" : "lab-warning"}>{comparisonText(comparison)}</div> : null}

          <h2>Runs</h2>
          <div className="lab-table-wrap">
            <table className="lab-table">
              <thead>
                <tr><th scope="col">Run</th><th scope="col">Version</th><th scope="col">Models</th><th scope="col">Execution</th><th scope="col">Samples</th></tr>
              </thead>
              <tbody>
                {[...runs].reverse().map((run: ExperimentRun) => {
                  const named = results.summaries.find((item) => item.runId === run.id)?.models.map((model) => value?.models.find((item) => item.id === model.modelId)?.name ?? model.modelId ?? "unnamed") ?? [];
                  return (
                    <tr key={run.id}>
                      <td><button type="button" className="lab-link" onClick={() => { service.open(projectId, { kind: "sample", runId: run.id }); props.go("Samples"); }}><code>{run.id}</code></button></td>
                      <td>v{versions.find((version) => version.id === run.versionId)?.number ?? "?"}</td>
                      <td>{named.length > 3 ? `${named.length} models` : named.join(", ") || "—"}</td>
                      <td>
                        {runStatusLabel(run.status)}{run.inputsChanged?.length ? `, ${run.inputsChanged.length} inputs changed during it` : ""}
                        {run.warnings?.map((warning) => <div key={warning} className="lab-warning">{warning}</div>)}
                      </td>
                      <td>{run.samples ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div></div>
  );
}

/** Each finished run's summary, how each version compares with the newest, and the newest run's labels. */
function useResults(projectId: string, runs: ExperimentRun[], newest: ExperimentRun | null, notify: (message: string) => void) {
  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [comparisons, setComparisons] = useState<Record<string, Comparison>>({});
  const [labels, setLabels] = useState<RunLabels | null>(null);
  const runKey = runs.map((run) => `${run.id}:${run.status}`).join(",");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const loaded = await Promise.all(runs.map((run) => service.summary(projectId, run.id)));
        const last = loaded.at(-1)?.versionId;
        const distinct = last ? [...new Set(loaded.map((item) => item.versionId))] : [];
        const compared = await Promise.all(distinct.map(async (version) => [version, await service.compare(projectId, last!, version)] as const));
        const labeled = newest ? await service.labels(projectId, newest.id) : null;
        if (live) {
          setSummaries(loaded);
          setComparisons(Object.fromEntries(compared));
          setLabels(labeled);
        }
      } catch (error) {
        if (live) notify(messageOf(error));
      }
    })();
    return () => {
      live = false;
    };
    // `runKey` says when the runs changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify, projectId, runKey, newest?.id]);

  return { summaries, comparisons, labels };
}
