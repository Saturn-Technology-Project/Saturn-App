import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  comparisonText,
  runHasResults,
  runStatusLabel,
  type Comparison,
  type ExperimentDraft,
  type ExperimentRun,
  type FrozenVersion,
  type ModelNode,
  type ModelRole,
} from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

import { ScoreChart } from "./ScoreChart.js";

const service = desktop.research;
const EVALUATION_FIELDS = ["dataset", "split", "sampleSet", "scorer", "promptFormat", "chatTemplate"] as const;

/** What an experiment measures, its frozen versions and runs, and whether two versions can be compared. */
export function Experiments(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(async () => ({
    drafts: (await service.experiments(projectId)).items as ExperimentDraft[],
    versions: (await service.versions(projectId)).items as FrozenVersion[],
    runs: (await service.runs(projectId)).items as ExperimentRun[],
    models: (await service.models(projectId)).items as ModelNode[],
  }), props.notify);
  const [selected, setSelected] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [binding, setBinding] = useState<{ modelId: string; role: ModelRole }>({ modelId: "", role: "base" });
  const [compared, setCompared] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const drafts = value?.drafts ?? [];
  const draft = drafts.find((item) => item.id === selected) ?? drafts[drafts.length - 1];
  const spec = ((draft as (ExperimentDraft & { evaluation?: Record<string, unknown> }) | undefined)?.evaluation ?? {}) as Record<string, unknown>;
  const bound = ((draft as (ExperimentDraft & { models?: { modelId: string; role: ModelRole }[] }) | undefined)?.models ?? []);
  const versions = (value?.versions ?? []).filter((item) => item.experimentId === draft?.id);
  const runs = (value?.runs ?? []).filter((item) => item.experimentId === draft?.id);

  async function saveEvaluation() {
    if (!draft) return;
    // An empty chat template field states that there is none, which is different from not saying.
    const evaluation: Record<string, unknown> = { generation: {}, chatTemplate: null, ...spec };
    for (const key of EVALUATION_FIELDS) {
      if (key in edits) evaluation[key] = edits[key] === "" && key === "chatTemplate" ? null : edits[key];
    }
    try {
      await service.updateExperiment(projectId, draft, { evaluation, models: bound } as Partial<ExperimentDraft>);
      setEdits({});
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  async function bindModel() {
    if (!draft || !binding.modelId) return;
    try {
      await service.updateExperiment(projectId, draft, { models: [...bound, binding] } as Partial<ExperimentDraft>);
      setBinding({ modelId: "", role: "base" });
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
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

  return (
    <div className="lab-page"><div className="lab-page-inner">
      <h1>Experiments</h1>
      {drafts.length === 0 ? <p className="lab-lead">Running a command in the workspace creates the first experiment.</p> : null}
      {drafts.map((item) => (
        <button type="button" key={item.id} aria-pressed={item.id === draft?.id} className={item.id === draft?.id ? "lab-list-item active" : "lab-list-item"} onClick={() => setSelected(item.id)}>
          <strong>{item.title}</strong> <code className="lab-muted">{item.command}</code>
        </button>
      ))}
      {draft ? (
        <>
          <h2>How it measures</h2>
          <p className="lab-lead">Two runs compare only when all of this matches. Training data is not part of it.</p>
          <div className="lab-form">
            {EVALUATION_FIELDS.map((key) => (
              <label className="lab-field" key={key}>
                <span>{key === "sampleSet" ? "Sample set" : key === "promptFormat" ? "Prompt format" : key === "chatTemplate" ? "Chat template (empty for none)" : key[0].toUpperCase() + key.slice(1)}</span>
                <input value={edits[key] ?? String(spec[key] ?? "")} onChange={(event) => setEdits({ ...edits, [key]: event.target.value })} />
              </label>
            ))}
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
                {value?.models.map((model) => (
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

          <ScoreChart projectId={projectId} runs={runs.filter((run) => runHasResults(run.status))} versions={versions} models={value?.models ?? []} notify={props.notify} />

          <h2>Frozen versions</h2>
          <div className="lab-table-wrap">
            <table className="lab-table">
              <thead>
                <tr><th scope="col">Compare</th><th scope="col">Version</th><th scope="col">Runs</th><th scope="col">Created</th></tr>
              </thead>
              <tbody>
                {versions.map((version) => (
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
                <tr><th scope="col">Run</th><th scope="col">Version</th><th scope="col">Execution</th><th scope="col">Samples</th></tr>
              </thead>
              <tbody>
                {[...runs].reverse().map((run) => (
                  <tr key={run.id}>
                    <td><code>{run.id}</code></td>
                    <td>v{versions.find((version) => version.id === run.versionId)?.number ?? "?"}</td>
                    <td>{runStatusLabel(run.status)}{run.inputsChanged?.length ? `, ${run.inputsChanged.length} inputs changed during it` : ""}</td>
                    <td>{run.samples ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div></div>
  );
}

