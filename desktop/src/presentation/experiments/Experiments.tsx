import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  comparisonText,
  DEFAULT_LABELS,
  EVALUATION_FIELD_NAMES,
  runHasResults,
  runStatusLabel,
  scoreSources,
  labelsOf,
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
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { Checkbox } from "../ui/base/Checkbox.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { Textarea } from "../ui/base/Textarea.js";
import { classes } from "../ui/base/classes.js";
import { Loading, messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

import { Mechanism } from "./Mechanism.js";
import { ScoreChart } from "./ScoreChart.js";
import { ImportResults } from "./ImportResults.js";
import { TrainingMetrics } from "./TrainingMetrics.js";

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
/** Which badge tone marks a finding: an AI suggestion stands apart, and a conclusion is the person's. */
const FINDING_TONES: Record<FindingKind, "neutral" | "accent" | "violet"> = { observation: "neutral", ai_suggestion: "violet", conclusion: "accent" };
/** The color of a verdict's word; the word itself always says it too. */
const VERDICT_TEXT: Record<Verdict, string> = { undecided: "", supported: "text-good", refuted: "text-destructive", inconclusive: "text-wait" };
/** What a Question or Hypothesis choice holds while none is set, since a choice cannot hold an empty string. */
const NOT_SET = "__not_set";
/** Small quiet text, and a warning in the same size. */
const MUTED = "text-xs text-muted-foreground";
const WARNING = "text-xs text-wait";
/** A section's heading inside the page. */
const SECTION = "mt-5! mb-2 text-sm font-semibold";
/** A small fact across the top of the record. */
const STAT = "flex flex-col gap-0.5 rounded-lg bg-panel p-2.5 text-xs";
/** Cards side by side, and one card in them. */
const CARDS = "mt-2 mb-4 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3";
const CARD = "gap-0.5 border-0 bg-panel px-3.5 py-3";
const HEADLINE = "my-0.5 block text-lg font-semibold";
/** A card that is a button taking the person to the samples behind a number. */
const SOURCE = "flex flex-col items-start gap-1 rounded-lg border-0 bg-panel px-3.5 py-3 text-left text-foreground hover:bg-muted";
/** A heading cell and a body cell of a table. */
const HEAD = "px-2 py-1.5 text-left font-medium whitespace-nowrap text-muted-foreground";
const CELL = "border-t border-border p-2 align-top wrap-anywhere";

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
  const results = useResults(projectId, finished, newest, props.notify, draft?.revision);

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
    const labelAliases = { ...draft?.labelAliases };
    for (const [key, value] of Object.entries(edits)) {
      if (!key.startsWith("alias:")) continue;
      if (value.trim()) labelAliases[key.slice(6)] = value.trim();
      else delete labelAliases[key.slice(6)];
    }
    await change({ evaluation, models: bound, labelAliases, ...(labels === undefined ? {} : { labels }) });
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[920px] px-6 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-(length:--text-title) font-semibold">Experiments</h1>
        {draft ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" data-tour="experiments-export" onClick={() => void exportRecord()}>Export</Button>
            <Button data-tour="experiments-freeze" onClick={() => void freeze()}>New version</Button>
          </div>
        ) : null}
      </div>
      {exported ? <Notice tone="good" className="my-2">Written to {exported} in the project.</Notice> : null}
      <ImportResults projectId={projectId} onImported={(id) => { setSelected(id); void refresh(); }} notify={props.notify} />
      {!value ? <Loading /> : null}
      {value && drafts.length === 0 ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Running a command in the workspace creates the first experiment.</p> : null}
      {drafts.length > 1 ? drafts.map((item) => (
        <Button key={item.id} variant={item.id === draft?.id ? "soft" : "ghost"} aria-pressed={item.id === draft?.id} className="h-auto min-h-8 w-full justify-start gap-3 py-1 text-left" title={item.command} onClick={() => setSelected(item.id)}>
          <strong className="max-w-[55%] shrink-0 truncate">{item.title}</strong>
          <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.command}</code>
        </Button>
      )) : null}
      {draft ? (
        <>
          <div className="mt-3 mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2" data-tour="experiments-links">
            <Choice label="Question" className={STAT} value={draft.questionId ?? NOT_SET} options={[{ value: NOT_SET, label: "Not set" }, ...(value?.questions ?? []).map((item: Question) => ({ value: item.id, label: item.title }))]} onChange={(chosen) => void change({ questionId: chosen === NOT_SET ? undefined : chosen })} />
            <Choice label="Hypothesis" className={STAT} value={draft.hypothesisId ?? NOT_SET} options={[{ value: NOT_SET, label: "Not set" }, ...(value?.hypotheses ?? []).map((item: Hypothesis) => ({ value: item.id, label: item.title }))]} onChange={(chosen) => void change({ hypothesisId: chosen === NOT_SET ? undefined : chosen })} />
            <div className={classes(STAT, "ring-1 ring-input")}><span className={MUTED}>Experiment</span><strong>{versions.length ? `v${versions.at(-1)?.number} frozen` : "Not frozen yet"}</strong></div>
            <div className={STAT}><span className={MUTED}>Runs</span><strong>{runs.length}</strong></div>
            <div className={STAT}><span className={MUTED}>Evidence</span><strong>{sources ? `${sources.scored} samples` : "None yet"}</strong></div>
            <div className={STAT}><span className={MUTED}>Findings</span><strong>{findings.length ? `${findings.length}, ${findings.some((item) => item.kind === "conclusion") ? "concluded" : "no conclusion"}` : "None"}</strong></div>
          </div>

          <div className={CARDS}>
            <Card className={CARD}>
              <div className={MUTED}>Execution</div>
              <strong className={HEADLINE}>{newest ? runStatusLabel(newest.status) : runs.length ? runStatusLabel(runs.at(-1)!.status) : "Not run"}</strong>
              <div className={MUTED}>{finished.length} of {runs.length} runs have results. Execution says nothing about whether the hypothesis holds.</div>
            </Card>
            <Card className={classes(CARD, hypothesis?.verdict === "undecided" && "ring-1 ring-wait")}>
              <div className={MUTED}>Hypothesis</div>
              {hypothesis ? (
                <>
                  <strong className={classes(HEADLINE, VERDICT_TEXT[hypothesis.verdict])}>{hypothesis.verdict[0].toUpperCase() + hypothesis.verdict.slice(1)}</strong>
                  <div className={MUTED}>{hypothesis.title}</div>
                  <Choice label="Only you set this" className="max-w-[220px]" value={hypothesis.verdict} options={VERDICTS.map((verdict) => ({ value: verdict, label: verdict[0].toUpperCase() + verdict.slice(1) }))} onChange={(chosen) => void service.setVerdict(projectId, hypothesis, chosen as Verdict).then(refresh).catch((error: unknown) => props.notify(messageOf(error)))} />
                </>
              ) : (
                <div className={MUTED}>Choose the hypothesis this experiment tests, above.</div>
              )}
            </Card>
          </div>

          <ScoreChart projectId={projectId} runs={finished} versions={versions} models={value?.models ?? []} summaries={results.summaries} comparisons={results.comparisons} />
          {newest ? <TrainingMetrics key={newest.id} projectId={projectId} runId={newest.id} notify={props.notify} /> : null}

          {sources && newest ? (
            <>
              <h2 className={SECTION} data-tour="experiments-sources">Where the score comes from</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">The newest run with results, {newest.id}.</p>
              <div className={CARDS}>
                <button type="button" className={SOURCE} onClick={() => toSamples("all")}>
                  <strong>Model behavior</strong>
                  <span className={MUTED}>{sources.scored} samples the scorer judged</span>
                </button>
                <button type="button" className={classes(SOURCE, sources.disputed > 0 && "ring-1 ring-wait")} onClick={() => toSamples("disputed")}>
                  <strong>Scorer in question</strong>
                  <span className={MUTED}>{sources.reviewed ? `${sources.disputed} of ${sources.reviewed} reviewed disagree with the scorer` : "Nothing reviewed yet"}</span>
                </button>
                <button type="button" className={SOURCE} onClick={() => toSamples("errors")}>
                  <strong>Errors</strong>
                  <span className={MUTED}>{sources.infrastructure} infrastructure, excluded{sources.otherErrors ? `; ${sources.otherErrors} model or scorer` : ""}</span>
                </button>
              </div>
            </>
          ) : null}

          <h2 className={SECTION}>Does the mechanism change too?</h2>
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

          <h2 className={SECTION}>Findings</h2>
          <div className="my-2 flex flex-wrap gap-1.5">
            {findings.length === 0 ? <span className={MUTED}>None linked to this experiment's runs yet.</span> : null}
            {findings.map((finding: Finding) => (
              <Badge key={finding.id} tone={FINDING_TONES[finding.kind]} title={finding.text}>
                {FINDING_LABELS[finding.kind]}{finding.kind === "ai_suggestion" ? " · marked" : finding.kind === "conclusion" ? " · yours" : ""}{finding.runIds?.[0] ? ` · ${finding.runIds[0]}` : ""}
              </Badge>
            ))}
          </div>
          {[...findings].reverse().slice(0, 3).map((finding) => (
            <Card key={finding.id} className="mb-2 gap-1 border-0 bg-panel px-3.5 py-3">
              <div className={MUTED}>{FINDING_LABELS[finding.kind]}</div>
              <div className="text-sm">{finding.text}</div>
            </Card>
          ))}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void conclude();
            }}
          >
            <div className="flex-[1_1_320px]" data-tour="experiments-conclusion">
              <Field label="Conclusion">
                <Textarea rows={2} value={conclusion} placeholder={newest ? `Saved with run ${newest.id} and its exact conditions.` : "Saved with this experiment."} onChange={(event) => setConclusion(event.target.value)} />
              </Field>
            </div>
            <Button type="submit" variant="outline" disabled={!conclusion.trim()}>Save conclusion</Button>
          </form>

          <h2 className={SECTION} data-tour="experiments-measures">How it measures</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Two runs compare only when all of this matches. Training data is not part of it.</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            {EVALUATION_FIELD_NAMES.map((key) => (
              <Field label={FIELD_LABELS[key]} className="flex-[1_1_160px]" key={key}>
                <Input value={edits[key] ?? String(spec[key] ?? "")} onChange={(event) => setEdits({ ...edits, [key]: event.target.value })} />
              </Field>
            ))}
            <Field label="Label names, comma separated" className="flex-[1_1_160px]">
              <Input value={edits.labels ?? (draft.labels ?? []).join(", ")} placeholder={DEFAULT_LABELS.join(", ")} onChange={(event) => setEdits({ ...edits, labels: event.target.value })} />
            </Field>
            {labelsOf({ ...draft, labels: (edits.labels ?? (draft.labels ?? []).join(",")).split(",") }).map((name) => (
              <Field label={`Scorer word for “${name}”`} className="flex-[1_1_160px]" key={`alias:${name}`}>
                <Input value={edits[`alias:${name}`] ?? draft.labelAliases?.[name] ?? ""} placeholder={name} onChange={(event) => setEdits({ ...edits, [`alias:${name}`]: event.target.value })} />
              </Field>
            ))}
            <div className={classes(MUTED, "w-full")}>Optional wording matches, such as “Wrong name” → “Wrong”. Applies to this experiment's review comparisons, including earlier labels; original labels and scores stay unchanged.</div>
            <Button variant="outline" onClick={() => void saveEvaluation()}>
              Save
            </Button>
          </div>

          <h2 className={SECTION}>Models</h2>
          {bound.map((item) => (
            <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5 text-sm" key={`${item.modelId}-${item.role}`}>
              <span className="min-w-0 flex-[1_1_220px] wrap-anywhere">{value?.models.find((model) => model.id === item.modelId)?.name ?? value?.models.find((model) => model.id === item.modelId)?.source ?? item.modelId}</span>
              <span className={MUTED}>{item.role}</span>
            </div>
          ))}
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Choice label="Model" className="flex-[1_1_160px]" placeholder="Choose" value={binding.modelId} options={(value?.models ?? []).map((model: ModelNode) => ({ value: model.id, label: model.name || model.source }))} onChange={(chosen) => setBinding({ ...binding, modelId: chosen })} />
            <Choice label="Role" className="flex-[1_1_160px]" value={binding.role} options={[{ value: "base", label: "Base" }, { value: "reference", label: "Reference" }, { value: "policy", label: "Policy" }]} onChange={(chosen) => setBinding({ ...binding, role: chosen as ModelRole })} />
            <Button variant="outline" disabled={!binding.modelId} onClick={() => void bindModel()}>
              Add
            </Button>
          </div>

          <h2 className={SECTION}>Frozen versions</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" aria-label="Frozen versions">
              <thead>
                <tr><th scope="col" className={HEAD}>Compare</th><th scope="col" className={HEAD}>Version</th><th scope="col" className={HEAD}>Runs</th><th scope="col" className={HEAD}>Created</th></tr>
              </thead>
              <tbody>
                {versions.map((version: FrozenVersion) => (
                  <tr key={version.id}>
                    <td className={CELL}><Checkbox aria-label={`Compare version ${version.number}`} checked={compared.includes(version.id)} onCheckedChange={() => void toggleCompared(version.id)} /></td>
                    <td className={CELL}>v{version.number}</td>
                    <td className={CELL}>{runs.filter((run) => run.versionId === version.id).length}</td>
                    <td className={CELL}>{new Date(version.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {comparison ? <div className={comparison.result === "comparable" ? MUTED : WARNING}>{comparisonText(comparison)}</div> : null}

          <h2 className={SECTION}>Runs</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" aria-label="Runs">
              <thead>
                <tr><th scope="col" className={HEAD}>Run</th><th scope="col" className={HEAD}>Version</th><th scope="col" className={HEAD}>Models</th><th scope="col" className={HEAD}>Execution</th><th scope="col" className={HEAD}>Samples</th></tr>
              </thead>
              <tbody>
                {[...runs].reverse().map((run: ExperimentRun) => {
                  const named = results.summaries.find((item) => item.runId === run.id)?.models.map((model) => value?.models.find((item) => item.id === model.modelId)?.name ?? model.modelId ?? "unnamed") ?? [];
                  return (
                    <tr key={run.id}>
                      <td className={CELL}><Button variant="ghost" size="small" className="text-primary" onClick={() => { service.open(projectId, { kind: "sample", runId: run.id }); props.go("Samples"); }}><code>{run.id}</code></Button></td>
                      <td className={CELL}>v{versions.find((version) => version.id === run.versionId)?.number ?? "?"}</td>
                      <td className={CELL}>{named.length > 3 ? `${named.length} models` : named.join(", ") || "—"}</td>
                      <td className={CELL}>
                        {runStatusLabel(run.status)}{run.inputsChanged?.length ? `, ${run.inputsChanged.length} inputs changed during it` : ""}
                        {run.warnings?.map((warning) => <div key={warning} className={WARNING}>{warning}</div>)}
                      </td>
                      <td className={CELL}>{run.samples ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      </div>
    </div>
  );
}

/** Each finished run's summary, how each version compares with the newest, and the newest run's labels. */
function useResults(projectId: string, runs: ExperimentRun[], newest: ExperimentRun | null, notify: (message: string) => void, labelRevision?: number) {
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
  }, [labelRevision, notify, projectId, runKey, newest?.id]);

  return { summaries, comparisons, labels };
}
