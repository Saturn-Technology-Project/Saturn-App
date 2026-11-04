import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { comparisonText, lineageTracks, runHasResults, scoreText, type Comparison, type ModelNode, type ModelSummary } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Empty, messageOf } from "../ui/Parts.js";
import { Split } from "../ui/Split.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;

/** What a model's newest run found. */
interface Latest {
  runId: string;
  versionId: string;
  summary: ModelSummary;
}

/** Each model's newest run with results. */
async function latestResults(projectId: string): Promise<Record<string, Latest>> {
  const runs = (await service.runs(projectId)).items.filter((run) => runHasResults(run.status));
  const latest: Record<string, Latest> = {};
  for (const run of runs) {
    const summary = await service.summary(projectId, run.id);
    for (const model of summary.models) {
      if (model.modelId) latest[model.modelId] = { runId: run.id, versionId: summary.versionId, summary: model };
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
      // A node compares with its parent only if both were measured the same way.
      const compared: Record<string, Comparison> = {};
      for (const model of models) {
        const own = latest[model.id];
        const parent = model.parentId ? latest[model.parentId] : undefined;
        if (own && parent) {
          compared[model.id] = own.versionId === parent.versionId ? { result: "comparable", differs: [], missing: [] } : await service.compare(projectId, parent.versionId, own.versionId);
        }
      }
      return { models, latest, compared };
    },
    props.notify,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ source: "", name: "", weightsRevision: "", parentId: "", trainingData: "" });
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
      });
      setForm({ source: "", name: "", weightsRevision: "", parentId: added.id, trainingData: "" });
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
  const details = current ? (
    <div className="lab-lineage-detail">
      <h2>{nameOf(current)}</h2>
      <div className="lab-detail-row"><span className="lab-muted">Source</span><code>{current.source}</code></div>
      <div className="lab-detail-row"><span className="lab-muted">Revision</span>{current.floating ? <span className="lab-tag warn">Not fixed, so it can change</span> : <code>{current.weightsRevision}</code>}</div>
      <div className="lab-detail-row"><span className="lab-muted">Parent</span><span>{models.find((item) => item.id === current.parentId)?.source ?? "None"}</span></div>
      <div className="lab-detail-row"><span className="lab-muted">Training data</span><span>{current.trainingData ?? "Not recorded"}</span></div>
      {value?.compared[current.id] && value.compared[current.id].result !== "comparable" ? <div className="lab-notice">{comparisonText(value.compared[current.id])} from its parent.</div> : null}
      <h2>Last measured</h2>
      {value?.latest[current.id] ? (
        <>
          {Object.entries(value.latest[current.id].summary.scores).map(([name, score]) => (
            <div className="lab-detail-row" key={name}>
              <span className="lab-muted">{name}</span>
              <span>{scoreText(score.mean)} <span className="lab-muted">n = {score.count}</span></span>
            </div>
          ))}
          <div className="lab-detail-row"><span className="lab-muted">Run</span><code>{value.latest[current.id].runId}</code></div>
          <button type="button" className="lab-button" onClick={() => props.go("Samples")}>Review its samples</button>
        </>
      ) : (
        <p className="lab-muted">No run has named this model. A run names one with each sample's modelId.</p>
      )}
      <p className="lab-muted">Features from different models are not treated as the same until you record how they were aligned and test them with an intervention.</p>
      <button
        type="button"
        className="lab-button"
        onClick={() => {
          setForm({ source: "", name: "", weightsRevision: "", parentId: current.id, trainingData: "" });
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
                      {compared && compared.result === "not_comparable" ? <span className="lab-tag warn">Not comparable</span> : compared && compared.result === "unknown" ? <span className="lab-tag">Cannot tell</span> : model.floating ? <span className="lab-tag warn">Revision not fixed</span> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

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
