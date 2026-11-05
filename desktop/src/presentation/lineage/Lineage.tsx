import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { comparisonText, heldFixed, lineageTracks, mechanismOf, runHasResults, scoreText, type Comparison, type EvaluationSpec, type InsideItem, type ModelNode, type ModelSummary, type RunLabels } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Empty, messageOf } from "../ui/Parts.js";
import { Split } from "../ui/Split.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;

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
    <label className="lab-field">
      {label}
      <input value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </label>
  );

  const nameOf = (model: ModelNode) => model.name || model.source;
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
    <div className="lab-lineage-detail">
      <div className="lab-muted">{current.parentId ? (current.referenceId ? "Policy" : "Branch") : "Base model"}{current.floating ? "" : " · pinned weights"}</div>
      <h2>{nameOf(current)}</h2>
      <div className="lab-detail-row"><span className="lab-muted">Source</span><code>{current.source}</code></div>
      <div className="lab-detail-row"><span className="lab-muted">Revision</span>{current.floating ? <span className="lab-tag warn">Not fixed, so it can change</span> : <code>{current.weightsRevision}</code>}</div>
      <div className="lab-detail-row"><span className="lab-muted">Parent</span><span>{models.find((item) => item.id === current.parentId)?.source ?? "None"}</span></div>
      <div className="lab-detail-row"><span className="lab-muted">Reference model</span><span>{current.referenceId ? (models.find((item) => item.id === current.referenceId) ? nameOf(models.find((item) => item.id === current.referenceId)!) : current.referenceId) : "None"}</span></div>
      <div className="lab-detail-row"><span className="lab-muted">Produced by</span><span>{current.producedBy ?? "Not recorded"}</span></div>
      <div className="lab-detail-row"><span className="lab-muted">Training data</span><span>{current.trainingData ?? "Not recorded"}</span></div>
      {value?.compared[current.id] && value.compared[current.id].result !== "comparable" ? <div className="lab-notice">{comparisonText(value.compared[current.id])} from its parent. Measure it the same way, or start a new experiment.</div> : null}

      <h2>Behavior</h2>
      {measured ? (
        <>
          {Object.entries(measured.summary.scores).map(([name, score]) => (
            <div className="lab-detail-row" key={name}>
              <span className="lab-muted">{name}</span>
              <span>{scoreText(score.mean)} <span className="lab-muted">n = {score.count}</span></span>
            </div>
          ))}
          <div className="lab-detail-row"><span className="lab-muted">Run</span><code>{measured.runId}</code></div>
          <div className="lab-detail-row"><span className="lab-muted">Review</span><span>{measured.toReview ? `${measured.toReview} samples to review` : "Every scored sample labeled"}</span></div>
          <div className="lab-form">
            <button type="button" className="lab-button" onClick={() => { service.open(projectId, { kind: "sample", runId: measured.runId }); props.go("Samples"); }}>Open samples at this node</button>
            <button type="button" className="lab-button" onClick={() => props.go("Experiments")}>Open its experiment</button>
          </div>
        </>
      ) : (
        <p className="lab-muted">No run has named this model. A run names one with each sample's modelId.</p>
      )}

      <h2>Mechanism</h2>
      {(() => {
        const known = measured ? mechanismOf(value?.inside[measured.runId] ?? [], current.id) : [];
        const readings = measured ? (value?.inside[measured.runId] ?? []).filter((item) => item.kind === "reading" && item.modelId === current.id).length : 0;
        return known.length ? (
          known.map((item, index) => (
            <div className="lab-detail-row" key={index}>
              <span className="lab-muted">From {nameOf(models.find((model) => model.id === item.sourceModelId) ?? { source: item.sourceModelId ?? "?" } as ModelNode)}</span>
              <span>{item.layers.length ? `${item.layers.length === 1 ? "Layer" : "Layers"} ${item.layers.join(", ")} ${item.layers.length === 1 ? "restores" : "restore"} ${item.restored} of ${item.of}${item.layers.length > 1 ? " (tied)" : ""}` : `No layer restores any of ${item.of}`}</span>
            </div>
          ))
        ) : (
          <p className="lab-muted">{readings ? `${readings} activation readings, no patch yet.` : "No intervention is recorded at this node. Under Experiments, sweep every layer into it from another node; a sample's Look inside does one layer."}</p>
        );
      })()}
      <div className="lab-card">
        <div className="lab-muted">Feature alignment across nodes</div>
        Not set. Features from different models are not treated as the same until you record how they were aligned and test them with an intervention.
      </div>

      <h2>Your note</h2>
      {note === null ? (
        <>
          <div>{current.note || <span className="lab-muted">No note yet.</span>}</div>
          <button type="button" className="lab-button quiet" onClick={() => setNote(current.note ?? "")}>{current.note ? "Change" : "Write one"}</button>
        </>
      ) : (
        <form
          className="lab-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveNote();
          }}
        >
          <textarea aria-label="Your note on this model" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
          <button type="submit" className="lab-button">Save</button>
          <button type="button" className="lab-button quiet" onClick={() => setNote(null)}>Cancel</button>
        </form>
      )}

      <button
        type="button"
        className="lab-button"
        style={{ marginTop: 12 }}
        onClick={() => {
          setForm({ source: "", name: "", weightsRevision: "", parentId: current.id, trainingData: "", referenceId: "", producedBy: "" });
          setAdding(true);
        }}
      >
        Branch from here
      </button>
    </div>
  ) : null;

  return (
    <Split id="lineage" side="right" size={320} minimum={240} label="Model details" open={Boolean(current)} pane={details}>
      <div className="lab-page">
        <div className="lab-page-inner">
          <h1>Model lineage</h1>
          <p className="lab-lead">From checkpoints to fine-tuned and preference-trained branches. Saturn records where weights are, and does not copy them.</p>
          {value && models.length === 0 && !adding ? (
            <Empty title="No models yet" action={<button type="button" className="lab-button primary" onClick={() => setAdding(true)}>Add the first model</button>}>
              Add a checkpoint to start a lineage.
            </Empty>
          ) : null}
          {lineageTracks(models).map((track) => (
            <section className="lab-track" key={track.nodes[0].id}>
              <div className="lab-muted">{track.from ? `Branched from ${nameOf(track.from)}` : "Line"}</div>
              <div className="lab-track-nodes">
                {track.nodes.map((model) => {
                  const score = firstScore(value?.latest[model.id]);
                  const compared = value?.compared[model.id];
                  return (
                    <button type="button" key={model.id} aria-pressed={model.id === current?.id} className={model.id === current?.id ? "lab-node active" : "lab-node"} onClick={() => setSelected(model.id)}>
                      <span className="lab-node-name">{nameOf(model)}</span>
                      <span className="lab-node-score">{score ? scoreText(score.mean) : "Not measured"}</span>
                      {compared && compared.result === "not_comparable" ? <span className="lab-tag warn">Not comparable</span> : compared && compared.result === "unknown" ? <span className="lab-tag">Cannot tell</span> : model.floating ? <span className="lab-tag warn">Revision not fixed</span> : value?.latest[model.id]?.toReview ? <span className="lab-tag warn">{value.latest[model.id].toReview} to review</span> : score ? <span className="lab-tag good">Evaluated</span> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          {value?.fixed.length ? (
            <div className="lab-card" style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>Held fixed across the measured nodes</div>
              <div className="lab-fixed">
                {value.fixed.map((item) => (
                  <div key={item.field}>
                    <div className="lab-muted">{item.field}</div>
                    <code>{item.value}</code>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {models.length > 0 && !adding ? (
            <button type="button" className="lab-button" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
              Add a model
            </button>
          ) : null}
          {adding ? (
            <>
              <h2>Add a model</h2>
              <form
                className="lab-form"
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
                <label className="lab-field">
                  Reference model
                  <select value={form.referenceId} onChange={(event) => setForm({ ...form, referenceId: event.target.value })}>
                    <option value="">None</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {nameOf(model)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="lab-field">
                  Parent
                  <select value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })}>
                    <option value="">None</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {nameOf(model)}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="lab-button primary" disabled={!form.source.trim()}>
                  Add
                </button>
                <button type="button" className="lab-button quiet" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </Split>
  );
}
