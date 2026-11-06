import { Fragment, useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import {
  byAssistant,
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

import { DeleteExperiment } from "./DeleteExperiment.js";
import { Evidence } from "./Evidence.js";
import { Mechanism } from "./Mechanism.js";
import { RunSandbox } from "./RunSandbox.js";
import { ScoreChart } from "./ScoreChart.js";
import { ImportResults } from "./ImportResults.js";
import { TrainingMetrics } from "./TrainingMetrics.js";
import { ExperimentTitle } from "./ExperimentTitle.js";
import { ComparisonPanel } from "./ComparisonPanel.js";
import { RemoteRun } from "../environment/RemoteExecution.js";
import { Artifacts } from "./Artifacts.js";
import { ResearchBundle } from "./ResearchBundle.js";

const service = desktop.research;
const FIELD_LABELS: Record<(typeof EVALUATION_FIELD_NAMES)[number], string> = {
  dataset: t("Dataset"),
  split: t("Split"),
  sampleSet: t("Sample set"),
  scorer: t("Scorer"),
  promptFormat: t("Prompt format"),
  chatTemplate: t("Chat template (empty for none)"),
};
const FINDING_LABELS: Record<FindingKind, string> = { observation: t("Observation"), ai_suggestion: t("AI suggestion"), conclusion: t("Conclusion") };
const VERDICTS: Verdict[] = ["undecided", "supported", "refuted", "inconclusive"];
/** A verdict's word, as it is shown. */
const VERDICT_LABELS: Record<Verdict, string> = { undecided: t("Undecided"), supported: t("Supported"), refuted: t("Refuted"), inconclusive: t("Inconclusive") };
/** A model's role in an experiment, as it is shown. */
const ROLE_LABELS: Record<ModelRole, string> = { base: t("Base"), reference: t("Reference"), policy: t("Policy") };
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
  const [evidenceOf, setEvidenceOf] = useState<string | null>(null);
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
      props.notify(t("Version {number} frozen. The next run uses it.", { number: version.number }));
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
        <h1 className="text-(length:--text-title) font-semibold">{t("Experiments")}</h1>
        {draft ? (
          <div className="flex flex-wrap gap-2">
            <DeleteExperiment projectId={projectId} experiment={draft} onDeleted={() => { setSelected(null); void refresh(); }} />
            <Button variant="outline" data-tour="experiments-export" onClick={() => void exportRecord()}>{t("Export summary JSON")}</Button>
            <Button data-tour="experiments-freeze" onClick={() => void freeze()}>{t("New version")}</Button>
          </div>
        ) : null}
      </div>
      {exported ? <Notice tone="good" className="my-2">{t("Written to {path} in the project.", { path: exported })}</Notice> : null}
      <ImportResults projectId={projectId} onImported={(id) => { setSelected(id); void refresh(); }} notify={props.notify} />
      <ResearchBundle projectId={projectId} notify={props.notify} go={props.go} onImported={() => void refresh()} />
      <ComparisonPanel projectId={projectId} runs={value?.runs ?? []} notify={props.notify} go={props.go} />
      {draft ? <RemoteRun projectId={projectId} versions={versions} notify={props.notify} onStarted={() => void refresh()} /> : null}
      <Artifacts key={newest?.id ?? projectId} projectId={projectId} runId={newest?.id} notify={props.notify} go={props.go} />
      {draft ? <Choice label={t("Output contract for the next version")} className="my-3 max-w-72" value={draft.kind ?? "evaluation"} options={[{ value: "evaluation", label: t("Scored evaluation samples") }, { value: "training", label: t("Training metrics (samples optional)") }]} onChange={(kind) => void change({ kind: kind as "evaluation" | "training" })} /> : null}
      {!value ? <Loading /> : null}
      {value && drafts.length === 0 ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("Running a command in the workspace creates the first experiment.")}</p> : null}
      {drafts.length > 1 ? drafts.map((item) => (
        <Button key={item.id} variant={item.id === draft?.id ? "soft" : "ghost"} aria-pressed={item.id === draft?.id} className="h-auto min-h-8 w-full justify-start gap-3 py-1 text-left" title={item.command} onClick={() => setSelected(item.id)}>
          <strong className="max-w-[55%] shrink-0 truncate">{item.title}</strong>
          {item.imported ? <Badge tone="wait" className="shrink-0">{t("Imported")}</Badge> : null}
          <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.command}</code>
        </Button>
      )) : null}
      {draft ? (
        <>
          <ExperimentTitle key={`${draft.id}:${draft.revision}`} title={draft.title} onRename={(title) => change({ title })} />
          <div className="mt-3 mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2" data-tour="experiments-links">
            <Choice label={t("Question")} className={STAT} value={draft.questionId ?? NOT_SET} options={[{ value: NOT_SET, label: t("Not set") }, ...(value?.questions ?? []).map((item: Question) => ({ value: item.id, label: item.title }))]} onChange={(chosen) => void change({ questionId: chosen === NOT_SET ? undefined : chosen })} />
            <Choice label={t("Hypothesis")} className={STAT} value={draft.hypothesisId ?? NOT_SET} options={[{ value: NOT_SET, label: t("Not set") }, ...(value?.hypotheses ?? []).map((item: Hypothesis) => ({ value: item.id, label: item.title }))]} onChange={(chosen) => void change({ hypothesisId: chosen === NOT_SET ? undefined : chosen })} />
            <div className={classes(STAT, "ring-1 ring-input")}><span className={MUTED}>{t("Experiment")}</span><strong>{versions.length ? t("v{number} frozen", { number: versions.at(-1)?.number ?? "" }) : t("Not frozen yet")}</strong></div>
            <div className={STAT}><span className={MUTED}>{t("Runs")}</span><strong>{runs.length}</strong></div>
            <div className={STAT}><span className={MUTED}>{t("Evidence")}</span><strong>{sources ? t("{count} samples", { count: sources.scored }) : t("None yet")}</strong></div>
            <div className={STAT}><span className={MUTED}>{t("Findings")}</span><strong>{findings.length ? (findings.some((item) => item.kind === "conclusion") ? t("{count}, concluded", { count: findings.length }) : t("{count}, no conclusion", { count: findings.length })) : t("None")}</strong></div>
          </div>

          <div className={CARDS}>
            <Card className={CARD}>
              <div className={MUTED}>{t("Execution")}</div>
              <strong className={HEADLINE}>{newest ? runStatusLabel(newest.status) : runs.length ? runStatusLabel(runs.at(-1)!.status) : t("Not run")}</strong>
              <div className={MUTED}>{t("{finished} of {count} runs have results. Execution says nothing about whether the hypothesis holds.", { finished: finished.length, count: runs.length })}</div>
            </Card>
            <Card className={classes(CARD, hypothesis?.verdict === "undecided" && "ring-1 ring-wait")}>
              <div className={MUTED}>{t("Hypothesis")}</div>
              {hypothesis ? (
                <>
                  <strong className={classes(HEADLINE, VERDICT_TEXT[hypothesis.verdict])}>{VERDICT_LABELS[hypothesis.verdict]}</strong>
                  <div className={MUTED}>{hypothesis.title}</div>
                  {hypothesis.verdict !== "undecided" && byAssistant(hypothesis) ? <Badge tone="violet">{t("Set by the assistant")}</Badge> : null}
                  <Choice label={t("Verdict")} className="max-w-[220px]" value={hypothesis.verdict} options={VERDICTS.map((verdict) => ({ value: verdict, label: VERDICT_LABELS[verdict] }))} onChange={(chosen) => void service.setVerdict(projectId, hypothesis, chosen as Verdict).then(refresh).catch((error: unknown) => props.notify(messageOf(error)))} />
                </>
              ) : (
                <div className={MUTED}>{t("Choose the hypothesis this experiment tests, above.")}</div>
              )}
            </Card>
          </div>

          <ScoreChart projectId={projectId} runs={finished} versions={versions} models={value?.models ?? []} summaries={results.summaries} comparisons={results.comparisons} />
          {newest ? <TrainingMetrics key={newest.id} projectId={projectId} runId={newest.id} notify={props.notify} /> : null}

          {sources && newest ? (
            <>
              <h2 className={SECTION} data-tour="experiments-sources">{t("Where the score comes from")}</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("The newest run with results, {run}.", { run: newest.id })}</p>
              <div className={CARDS}>
                <button type="button" className={SOURCE} onClick={() => toSamples("all")}>
                  <strong>{t("Model behavior")}</strong>
                  <span className={MUTED}>{t("{count} samples the scorer judged", { count: sources.scored })}</span>
                </button>
                <button type="button" className={classes(SOURCE, sources.disputed > 0 && "ring-1 ring-wait")} onClick={() => toSamples("disputed")}>
                  <strong>{t("Scorer in question")}</strong>
                  <span className={MUTED}>{sources.reviewed ? t("{disputed} of {reviewed} reviewed disagree with the scorer", { disputed: sources.disputed, reviewed: sources.reviewed }) : t("Nothing reviewed yet")}</span>
                </button>
                <button type="button" className={SOURCE} onClick={() => toSamples("errors")}>
                  <strong>{t("Errors")}</strong>
                  <span className={MUTED}>{sources.otherErrors ? t("{count} infrastructure, excluded; {other} model or scorer", { count: sources.infrastructure, other: sources.otherErrors }) : t("{count} infrastructure, excluded", { count: sources.infrastructure })}</span>
                </button>
              </div>
            </>
          ) : null}

          <h2 className={SECTION}>{t("Does the mechanism change too?")}</h2>
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

          <h2 className={SECTION}>{t("Findings")}</h2>
          <div className="my-2 flex flex-wrap gap-1.5">
            {findings.length === 0 ? <span className={MUTED}>{t("None linked to this experiment's runs yet.")}</span> : null}
            {findings.map((finding: Finding) => (
              <Badge key={finding.id} tone={FINDING_TONES[finding.kind]} title={finding.text}>
                {FINDING_LABELS[finding.kind]} · {byAssistant(finding) ? t("by the assistant") : t("yours")}{finding.runIds?.[0] ? ` · ${finding.runIds[0]}` : ""}
              </Badge>
            ))}
          </div>
          {[...findings].reverse().slice(0, 3).map((finding) => (
            <Card key={finding.id} className="mb-2 gap-1 border-0 bg-panel px-3.5 py-3">
              <div className={MUTED}>{FINDING_LABELS[finding.kind]} · {byAssistant(finding) ? t("by the assistant") : t("yours")}</div>
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
              <Field label={t("Conclusion")}>
                <Textarea rows={2} value={conclusion} placeholder={newest ? t("Saved with run {run} and its exact conditions.", { run: newest.id }) : t("Saved with this experiment.")} onChange={(event) => setConclusion(event.target.value)} />
              </Field>
            </div>
            <Button type="submit" variant="outline" disabled={!conclusion.trim()}>{t("Save conclusion")}</Button>
          </form>

          <h2 className={SECTION} data-tour="experiments-measures">{t("How it measures")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("Two runs compare only when all of this matches. Training data is not part of it.")}</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            {EVALUATION_FIELD_NAMES.map((key) => (
              <Field label={FIELD_LABELS[key]} className="flex-[1_1_160px]" key={key}>
                <Input value={edits[key] ?? String(spec[key] ?? "")} onChange={(event) => setEdits({ ...edits, [key]: event.target.value })} />
              </Field>
            ))}
            <Field label={t("Label names, comma separated")} className="flex-[1_1_160px]">
              <Input value={edits.labels ?? (draft.labels ?? []).join(", ")} placeholder={DEFAULT_LABELS.join(", ")} onChange={(event) => setEdits({ ...edits, labels: event.target.value })} />
            </Field>
            {labelsOf({ ...draft, labels: (edits.labels ?? (draft.labels ?? []).join(",")).split(",") }).map((name) => (
              <Field label={t("Scorer word for “{name}”", { name })} className="flex-[1_1_160px]" key={`alias:${name}`}>
                <Input value={edits[`alias:${name}`] ?? draft.labelAliases?.[name] ?? ""} placeholder={name} onChange={(event) => setEdits({ ...edits, [`alias:${name}`]: event.target.value })} />
              </Field>
            ))}
            <div className={classes(MUTED, "w-full")}>{t("Optional wording matches, such as “Wrong name” → “Wrong”. Applies to this experiment's review comparisons, including earlier labels; original labels and scores stay unchanged.")}</div>
            <Button variant="outline" onClick={() => void saveEvaluation()}>
              {t("Save")}
            </Button>
          </div>

          <RunSandbox draft={draft} save={(fields) => change(fields)} />

          <h2 className={SECTION}>{t("Models")}</h2>
          {bound.map((item) => (
            <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5 text-sm" key={`${item.modelId}-${item.role}`}>
              <span className="min-w-0 flex-[1_1_220px] wrap-anywhere">{value?.models.find((model) => model.id === item.modelId)?.name ?? value?.models.find((model) => model.id === item.modelId)?.source ?? item.modelId}</span>
              <span className={MUTED}>{ROLE_LABELS[item.role] ?? item.role}</span>
            </div>
          ))}
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Choice label={t("Model")} className="flex-[1_1_160px]" placeholder={t("Choose")} value={binding.modelId} options={(value?.models ?? []).map((model: ModelNode) => ({ value: model.id, label: model.name || model.source }))} onChange={(chosen) => setBinding({ ...binding, modelId: chosen })} />
            <Choice label={t("Role")} className="flex-[1_1_160px]" value={binding.role} options={[{ value: "base", label: ROLE_LABELS.base }, { value: "reference", label: ROLE_LABELS.reference }, { value: "policy", label: ROLE_LABELS.policy }]} onChange={(chosen) => setBinding({ ...binding, role: chosen as ModelRole })} />
            <Button variant="outline" disabled={!binding.modelId} onClick={() => void bindModel()}>
              {t("Add")}
            </Button>
          </div>

          <h2 className={SECTION}>{t("Frozen versions")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" aria-label={t("Frozen versions")}>
              <thead>
                <tr><th scope="col" className={HEAD}>{t("Compare")}</th><th scope="col" className={HEAD}>{t("Version")}</th><th scope="col" className={HEAD}>{t("Runs")}</th><th scope="col" className={HEAD}>{t("Created")}</th></tr>
              </thead>
              <tbody>
                {versions.map((version: FrozenVersion) => (
                  <tr key={version.id}>
                    <td className={CELL}><Checkbox aria-label={t("Compare version {number}", { number: version.number })} checked={compared.includes(version.id)} onCheckedChange={() => void toggleCompared(version.id)} /></td>
                    <td className={CELL}>v{version.number}</td>
                    <td className={CELL}>{runs.filter((run) => run.versionId === version.id).length}</td>
                    <td className={CELL}>{new Date(version.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {comparison ? <div className={comparison.result === "comparable" ? MUTED : WARNING}>{comparisonText(comparison)}</div> : null}

          <h2 className={SECTION}>{t("Runs")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" aria-label={t("Runs")}>
              <thead>
                <tr><th scope="col" className={HEAD}>{t("Run")}</th><th scope="col" className={HEAD}>{t("Version")}</th><th scope="col" className={HEAD}>{t("Models")}</th><th scope="col" className={HEAD}>{t("Execution")}</th><th scope="col" className={HEAD}>{t("Samples")}</th></tr>
              </thead>
              <tbody>
                {[...runs].reverse().map((run: ExperimentRun) => {
                  const named = results.summaries.find((item) => item.runId === run.id)?.models.map((model) => value?.models.find((item) => item.id === model.modelId)?.name ?? model.modelId ?? t("unnamed")) ?? [];
                  return (
                    <Fragment key={run.id}>
                    <tr>
                      <td className={CELL}><Button variant="ghost" size="small" className="text-primary" onClick={() => { service.open(projectId, { kind: "sample", runId: run.id }); props.go("Samples"); }}><code>{run.id}</code></Button></td>
                      <td className={CELL}>v{versions.find((version) => version.id === run.versionId)?.number ?? "?"}</td>
                      <td className={CELL}>{named.length > 3 ? t("{count} models", { count: named.length }) : named.join(", ") || "—"}</td>
                      <td className={CELL}>
                        {run.inputsChanged?.length ? t("{status}, {count} inputs changed during it", { status: runStatusLabel(run.status), count: run.inputsChanged.length }) : runStatusLabel(run.status)}
                        {run.archived ? <span className="ml-1 text-muted-foreground">· {t("imported archive")}</span> : null}
                        {run.imported ? <Badge tone="wait" className="ml-1" title={t("Imported from a file. Saturn did not run it, and its model, data and scorer are only described.")}>{t("Imported, not run here")}</Badge> : null}
                        {run.remote ? <div className="my-1">SSH {run.remote.host}: {run.remoteConnection}, {run.remoteStatus ?? t("pending")}{run.resumeFrom ? ` · ${t("resume {run}", { run: run.resumeFrom })}` : ""}{run.remoteError ? <div className={WARNING}>{run.remoteError}</div> : null}{["starting", "running", "stopping"].includes(run.status) ? <Button variant="outline" size="small" onClick={() => void service.stopRun(projectId, run.id).then(() => refresh()).catch((error: unknown) => props.notify(messageOf(error)))}>{t("Request stop")}</Button> : null}</div> : null}
                        {run.warnings?.map((warning) => <div key={warning} className={WARNING}>{warning}</div>)}
                        {run.sealIntact === false ? <div className={WARNING}>{t("The samples changed after the run was sealed. They no longer stand for its results.")}</div> : null}
                        {run.imported ? null : (
                          <Button variant="ghost" size="small" className="text-muted-foreground" aria-expanded={evidenceOf === run.id} onClick={() => setEvidenceOf((current) => (current === run.id ? null : run.id))}>
                            {evidenceOf === run.id ? t("Hide evidence") : t("Evidence")}
                          </Button>
                        )}
                      </td>
                      <td className={CELL}>{run.samples ?? 0}</td>
                    </tr>
                    {evidenceOf === run.id ? (
                      <tr><td colSpan={5} className="px-2 pb-3"><Evidence projectId={projectId} runId={run.id} /></td></tr>
                    ) : null}
                    </Fragment>
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
