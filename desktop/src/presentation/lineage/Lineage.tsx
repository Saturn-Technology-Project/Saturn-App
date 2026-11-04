import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { lineageOrder, type ModelNode } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;

/** Checkpoints and their branches. Saturn records where weights are; it does not copy them. */
export function Lineage(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(async () => (await service.models(projectId)).items as ModelNode[], props.notify);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ source: "", name: "", weightsRevision: "", parentId: "", trainingData: "" });
  const models = value ?? [];
  const current = models.find((item) => item.id === selected);

  async function add() {
    try {
      const added = await service.addModel(projectId, {
        source: form.source.trim(),
        name: form.name.trim() || undefined,
        weightsRevision: form.weightsRevision.trim() || undefined,
        parentId: form.parentId || undefined,
        trainingData: form.trainingData.trim() || undefined,
      });
      setForm({ source: "", name: "", weightsRevision: "", parentId: form.parentId, trainingData: "" });
      setSelected(added.id);
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  const field = (key: keyof typeof form, label: string) => (
    <label className="lab-field">
      <span>{label}</span>
      <input value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </label>
  );

  return (
    <div className="lab-page"><div className="lab-page-inner">
      <h1>Model lineage</h1>
      <p className="lab-lead">From checkpoints to fine-tuned and preference-trained branches. A role such as base or policy belongs to how an experiment uses a model.</p>
      {lineageOrder(models).map(({ model, depth }) => (
        <button
          type="button"
          key={model.id}
          aria-pressed={selected === model.id}
          className={selected === model.id ? "lab-list-item active" : "lab-list-item"}
          style={{ paddingLeft: 10 + depth * 20 }}
          onClick={() => setSelected(model.id)}
        >
          <strong>{model.name || model.source}</strong>{" "}
          {model.floating ? <span className="lab-tag warn">No fixed revision</span> : <span className="lab-muted">{model.weightsRevision}</span>}
        </button>
      ))}
      {models.length === 0 ? <p className="lab-muted">No models yet.</p> : null}

      {current ? (
        <>
          <h2>{current.name || current.source}</h2>
          <div className="lab-row"><span>Source</span><code>{current.source}</code></div>
          <div className="lab-row"><span>Parent</span><span className="lab-muted">{models.find((item) => item.id === current.parentId)?.source ?? "None"}</span></div>
          <div className="lab-row"><span>Training data</span><span className="lab-muted">{current.trainingData ?? "Not recorded"}</span></div>
          <p className="lab-lead">Features from different models are not treated as the same until you record how they were aligned and test them with an intervention.</p>
        </>
      ) : null}

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
          <span>Parent</span>
          <select value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })}>
            <option value="">None</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || model.source}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="lab-button" disabled={!form.source.trim()}>
          Add
        </button>
      </form>
    </div></div>
  );
}

