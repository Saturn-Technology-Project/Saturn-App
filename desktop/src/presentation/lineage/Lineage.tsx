import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { comparisonText, earlierSweeps, heldFixed, lineageRows, mechanismOf, RESTORE_MEASURE_TEXT, runHasResults, scoreText, type Comparison, type EvaluationSpec, type InsideItem, type ModelNode, type ModelSummary, type RunLabels } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { Textarea } from "../ui/base/Textarea.js";
import { classes } from "../ui/base/classes.js";
import { Empty, messageOf, Page } from "../ui/Parts.js";
import { Split } from "../ui/Split.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;
/** Small quiet text. */
const MUTED = "text-xs text-muted-foreground";
/** A heading inside the page or the details, and a fact in the details with its value. */
const SECTION = "mt-5! mb-2 text-sm font-semibold";
const DETAIL_TITLE = "mt-2! mb-0.5 text-sm font-semibold";
const DETAIL_ROW = "flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-sm wrap-anywhere";
/** A row of fields and the buttons that go with them. */
const FORM = "flex flex-wrap items-end gap-2";
/** What a Reference model or Parent choice holds while none is chosen, since a choice cannot hold an empty string. */
const NONE = "__none";
/** The tree's columns: the model, its score and its status. */
const TREE_ROW = "grid grid-cols-[minmax(0,1fr)_76px_minmax(96px,150px)] items-center gap-3 px-3";

/** What a model's newest run found, and how much of it a person has looked at. */
interface Latest {
  runId: string;
  versionId: string;
  experimentId: string;
  summary: ModelSummary;
  /** Scored samples of this model not labeled yet. */
  toReview: number;
}

/** Each model's newest run with results. */
async function latestResults(projectId: string): Promise<Record<string, Latest>> {
  const runs = (await service.runs(projectId)).items.filter((run) => runHasResults(run.status));
  const latest: Record<string, Latest> = {};
  const labels: Record<string, RunLabels> = {};
  for (const run of runs) {
    const summary = await service.summary(projectId, run.id);
    for (const model of summary.models) {
      if (!model.modelId) continue;
      labels[run.id] ??= await service.labels(projectId, run.id);
      const labeled = Object.values(labels[run.id].labels).filter((item) => (item.modelId ?? null) === model.modelId).length;
      const errors = Object.values(model.errors).reduce((sum, count) => sum + count, 0);
      latest[model.modelId] = { runId: run.id, versionId: summary.versionId, experimentId: run.experimentId, summary: model, toReview: Math.max(0, model.samples - errors - labeled) };
    }
  }
  return latest;
}

/** The first score a summary holds, for showing one number on a node. */
function firstScore(latest: Latest | undefined): { name: string; mean: number | null } | null {
  const [entry] = Object.entries(latest?.summary.scores ?? {});
  return entry ? { name: entry[0], mean: entry[1].mean } : null;
}

/** From checkpoints to branches, each with what was last measured on it. */
export function Lineage(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(
    async () => {
      const models = (await service.models(projectId)).items;
      const latest = await latestResults(projectId);
      const versions = (await service.versions(projectId)).items;
      // What was looked at inside each model's newest run.
      const inside: Record<string, InsideItem[]> = {};
      for (const runId of new Set(Object.values(latest).map((item) => item.runId))) inside[runId] = (await service.insideList(projectId, runId)).items;
      // A node compares with its parent only if both were measured the same way.
      const compared: Record<string, Comparison> = {};
      for (const model of models) {
        const own = latest[model.id];
        const parent = model.parentId ? latest[model.parentId] : undefined;
        if (own && parent) {
          compared[model.id] = own.versionId === parent.versionId ? { result: "comparable", differs: [], missing: [] } : await service.compare(projectId, parent.versionId, own.versionId);
        }
      }
      // What the newest measurements hold fixed: the fields every compared pair shares.
      const specs = Object.values(latest).map((item) => versions.find((version) => version.id === item.versionId)?.evaluation ?? null);
      const fixed = specs.length ? heldFixed(specs[0], { result: "comparable", differs: [], missing: [] }).filter((field) => specs.every((spec) => JSON.stringify(spec?.[field.field as keyof EvaluationSpec]) === JSON.stringify(specs[0]?.[field.field as keyof EvaluationSpec]))) : [];
      return { models, latest, compared, fixed, inside };
    },
    props.notify,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ source: "", name: "", weightsRevision: "", parentId: "", trainingData: "", referenceId: "", producedBy: "" });
  const [note, setNote] = useState<string | null>(null);
  const models = value?.models ?? [];
  const current = models.find((item) => item.id === selected) ?? models.at(-1);

  async function add() {
    try {
      const added = await service.addModel(projectId, {
        source: form.source.trim(),
        name: form.name.trim() || undefined,
        weightsRevision: form.weightsRevision.trim() || undefined,
        parentId: form.parentId || undefined,
        trainingData: form.trainingData.trim() || undefined,
        referenceId: form.referenceId || undefined,
        producedBy: form.producedBy.trim() || undefined,
      });
      setForm({ source: "", name: "", weightsRevision: "", parentId: added.id, trainingData: "", referenceId: "", producedBy: "" });
      setSelected(added.id);
      setAdding(false);
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  const field = (key: keyof typeof form, label: string) => (
    <Field label={label} className="flex-[1_1_160px]">
      <Input value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </Field>
  );

  const nameOf = (model: ModelNode) => model.name || model.source;
  // The one score the list shows, named above it when the models agree on which.
  const scoreNames = new Set(models.map((model) => firstScore(value?.latest[model.id])?.name).filter(Boolean));
  const scoreName = scoreNames.size === 1 ? [...scoreNames][0] : null;
  const measured = current ? value?.latest[current.id] : undefined;

  async function saveNote() {
    if (!current || note === null) return;
    try {
      await service.updateModel(projectId, current, { note: note.trim() });
      setNote(null);
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  const details = current ? (
    <div className="flex flex-1 flex-col gap-1.5 overflow-auto bg-panel p-3.5" data-tour="lineage-details">
      <div className={MUTED}>{current.parentId ? (current.referenceId ? "Policy" : "Branch") : "Base model"}{current.floating ? "" : " · pinned weights"}</div>
      <h2 className={DETAIL_TITLE}>{nameOf(current)}</h2>
      <div className={DETAIL_ROW}><span className={MUTED}>Source</span><code>{current.source}</code></div>
      <div className={DETAIL_ROW}><span className={MUTED}>Revision</span>{current.floating ? <Badge tone="wait">Not fixed, so it can change</Badge> : <code>{current.weightsRevision}</code>}</div>
      <div className={DETAIL_ROW}><span className={MUTED}>Parent</span><span>{models.find((item) => item.id === current.parentId)?.source ?? "None"}</span></div>
      <div className={DETAIL_ROW}><span className={MUTED}>Reference model</span><span>{current.referenceId ? (models.find((item) => item.id === current.referenceId) ? nameOf(models.find((item) => item.id === current.referenceId)!) : current.referenceId) : "None"}</span></div>
      <div className={DETAIL_ROW}><span className={MUTED}>Produced by</span><span>{current.producedBy ?? "Not recorded"}</span></div>
      <div className={DETAIL_ROW}><span className={MUTED}>Training data</span><span>{current.trainingData ?? "Not recorded"}</span></div>
      {value?.compared[current.id] && value.compared[current.id].result !== "comparable" ? <Notice tone="wait">{comparisonText(value.compared[current.id])} from its parent. Measure it the same way, or start a new experiment.</Notice> : null}

      <h2 className={DETAIL_TITLE}>Behavior</h2>
      {measured ? (
        <>
          {Object.entries(measured.summary.scores).map(([name, score]) => (
            <div className={DETAIL_ROW} key={name}>
              <span className={MUTED}>{name}</span>
              <span>{scoreText(score.mean)} <span className={MUTED}>n = {score.count}</span></span>
            </div>
          ))}
          <div className={DETAIL_ROW}><span className={MUTED}>Run</span><code>{measured.runId}</code></div>
          <div className={DETAIL_ROW}><span className={MUTED}>Review</span><span>{measured.toReview ? `${measured.toReview} samples to review` : "Every scored sample labeled"}</span></div>
          <div className={classes(FORM, "mt-1.5")}>
            <Button variant="outline" onClick={() => { service.open(projectId, { kind: "sample", runId: measured.runId }); props.go("Samples"); }}>Open samples at this node</Button>
            <Button variant="outline" onClick={() => props.go("Experiments")}>Open its experiment</Button>
          </div>
        </>
      ) : (
        <p className={MUTED}>No run has named this model. A run names one with each sample's modelId.</p>
      )}

      <h2 className={DETAIL_TITLE}>Mechanism</h2>
      {(() => {
        const known = measured ? mechanismOf(value?.inside[measured.runId] ?? [], current.id) : [];
        const readings = measured ? (value?.inside[measured.runId] ?? []).filter((item) => item.kind === "reading" && item.current !== false && item.modelId === current.id).length : 0;
        const earlier = measured ? earlierSweeps(value?.inside[measured.runId] ?? [], current.id) : 0;
        const earlierNote = earlier ? <p className={MUTED}>{earlier === 1 ? "1 earlier sweep" : `${earlier} earlier sweeps`} came from a helper that has since changed. Kept with the run, not counted here; sweep again under Experiments.</p> : null;
        return known.length ? (
          <>
          {known.map((item, index) => (
            <div className={DETAIL_ROW} key={index}>
              <span className={MUTED}>From {nameOf(models.find((model) => model.id === item.sourceModelId) ?? { source: item.sourceModelId ?? "?" } as ModelNode)}</span>
              <span>{item.layers.length ? `${item.layers.length === 1 ? "Layer" : "Layers"} ${item.layers.join(", ")} ${item.layers.length === 1 ? "restores" : "restore"} ${item.restored} of ${item.of} ${RESTORE_MEASURE_TEXT[item.measure]}${item.layers.length > 1 ? " (tied)" : ""}` : `No layer restores any of ${item.of} ${RESTORE_MEASURE_TEXT[item.measure]}`}</span>
            </div>
          ))}
          {earlierNote}
          </>
        ) : (
          <>
          <p className={MUTED}>{readings ? `${readings} activation readings, no patch yet.` : "No intervention is recorded at this node. Under Experiments, sweep every layer into it from another node; a sample's Look inside does one layer."}</p>
          {earlierNote}
          </>
        );
      })()}
      <Card className="gap-1 p-3 text-sm">
        <div className={MUTED}>Feature alignment across nodes</div>
        Not set. Features from different models are not treated as the same until you record how they were aligned and test them with an intervention.
      </Card>

      <h2 className={DETAIL_TITLE}>Your note</h2>
      {note === null ? (
        <>
          <div className="text-sm">{current.note || <span className={MUTED}>No note yet.</span>}</div>
          <Button variant="ghost" className="mt-1.5 w-fit" onClick={() => setNote(current.note ?? "")}>{current.note ? "Change" : "Write one"}</Button>
        </>
      ) : (
        <form
          className={FORM}
          onSubmit={(event) => {
            event.preventDefault();
            void saveNote();
          }}
        >
          <Textarea aria-label="Your note on this model" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
          <Button type="submit" variant="outline">Save</Button>
          <Button variant="ghost" onClick={() => setNote(null)}>Cancel</Button>
        </form>
      )}

      <Button
        variant="outline"
        className="mt-3 w-fit"
        onClick={() => {
          setForm({ source: "", name: "", weightsRevision: "", parentId: current.id, trainingData: "", referenceId: "", producedBy: "" });
          setAdding(true);
        }}
      >
        Branch from here
      </Button>
    </div>
  ) : null;

  return (
    <Split id="lineage" side="right" size={320} minimum={240} label="Model details" open={Boolean(current)} pane={details}>
      <Page title="Model lineage" lead="From checkpoints to fine-tuned and preference-trained branches. Saturn records where weights are, and does not copy them.">
          {value && models.length === 0 && !adding ? (
            <Empty title="No models yet" action={<Button data-tour="lineage-add" onClick={() => setAdding(true)}>Add the first model</Button>}>
              Add a checkpoint to start a lineage.
            </Empty>
          ) : null}
          {models.length ? (
            <div className="mt-3.5 flex flex-col overflow-hidden rounded-lg border border-border" role="group" aria-label="Models, each under the one it came from">
              <div className={classes(TREE_ROW, "min-h-[30px] border-b border-border bg-panel text-[11.5px] text-muted-foreground")} aria-hidden="true">
                <span>Model</span>
                <span className="truncate text-right">{scoreName ?? "Score"}</span>
                <span>Status</span>
              </div>
              {lineageRows(models).map(({ model, depth, branch }) => {
                const score = firstScore(value?.latest[model.id]);
                const compared = value?.compared[model.id];
                return (
                  <button type="button" key={model.id} aria-pressed={model.id === current?.id} className={classes(TREE_ROW, "min-h-[34px] w-full border-0 border-b border-border text-left text-foreground last:border-b-0 hover:bg-muted", model.id === current?.id && "bg-muted ")} title={nameOf(model)} onClick={() => setSelected(model.id)}>
                    <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${Math.min(depth, 6) * 18}px` }}>
                      {/* The corner joining a model to the one above it, or straight on from it when the line is itself a branch. */}
                      {depth ? <span className={classes("-mt-[9px] h-3.5 w-2.5 flex-none rounded-bl-[3px] border-b border-l border-input", !branch && "mt-0 h-[34px] rounded-bl-none border-b-0")} aria-hidden="true" /> : null}
                      <span className="min-w-0 truncate font-mono text-xs">{nameOf(model)}</span>
                    </span>
                    <span className="truncate text-right text-sm tabular-nums" title={score ? score.name : undefined}>{score ? scoreText(score.mean) : "–"}</span>
                    <span className="flex min-w-0 overflow-hidden whitespace-nowrap">{compared && compared.result === "not_comparable" ? <Badge tone="wait">Not comparable</Badge> : compared && compared.result === "unknown" ? <Badge>Cannot tell</Badge> : model.floating ? <Badge tone="wait">Revision not fixed</Badge> : value?.latest[model.id]?.toReview ? <span className={MUTED}>{value.latest[model.id].toReview} to review</span> : score ? <Badge tone="good">Evaluated</Badge> : null}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {value?.fixed.length ? (
            <Card className="mt-4 gap-1.5 border-0 bg-panel px-3.5 py-3">
              <div className="mb-1.5 text-sm font-medium">Held fixed across the measured nodes</div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4 gap-y-2 text-xs">
                {value.fixed.map((item) => (
                  <div key={item.field}>
                    <div className={MUTED}>{item.field}</div>
                    <code>{item.value}</code>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
          {models.length > 0 && !adding ? (
            <Button variant="outline" className="mt-4 w-fit" data-tour="lineage-add" onClick={() => setAdding(true)}>
              Add a model
            </Button>
          ) : null}
          {adding ? (
            <>
              <h2 className={SECTION}>Add a model</h2>
              <form
                className={FORM}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (form.source.trim()) void add();
                }}
              >
                {field("source", "Source (name or local path)")}
                {field("name", "Name")}
                {field("weightsRevision", "Revision")}
                {field("trainingData", "Training data")}
                {field("producedBy", "Produced by (a script, a training run, a release)")}
                <Choice label="Reference model" className="flex-[1_1_160px]" value={form.referenceId || NONE} options={[{ value: NONE, label: "None" }, ...models.map((model) => ({ value: model.id, label: nameOf(model) }))]} onChange={(chosen) => setForm({ ...form, referenceId: chosen === NONE ? "" : chosen })} />
                <Choice label="Parent" className="flex-[1_1_160px]" value={form.parentId || NONE} options={[{ value: NONE, label: "None" }, ...models.map((model) => ({ value: model.id, label: nameOf(model) }))]} onChange={(chosen) => setForm({ ...form, parentId: chosen === NONE ? "" : chosen })} />
                <Button type="submit" disabled={!form.source.trim()}>
                  Add
                </Button>
                <Button variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </form>
            </>
          ) : null}
      </Page>
    </Split>
  );
}
