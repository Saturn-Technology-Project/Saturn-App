import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { ActivationView, ModelNode } from "../../domain/research.js";
import { messageOf } from "../ui/Parts.js";

const service = desktop.research;

/** What the runtime answered: activations, or why there are none. */
type Answer = { kind: "view"; view: ActivationView } | { kind: "unavailable"; reason: string } | null;

function unavailable(error: unknown): Answer {
  const message = messageOf(error);
  return { kind: "unavailable", reason: message };
}

/**
 * Inside a sample: the activations a run captured at each layer, and a patch of one layer from one model into another. Both
 * are asked of the runtime, which runs them in the project's own Python environment and keeps the result with the sample.
 */
export function LookInside(props: { projectId: string; runId: string; sampleId: string; modelId: string | null; candidates?: (string | null)[]; models: ModelNode[]; notify: (message: string) => void }) {
  const { projectId, runId, sampleId, models } = props;
  // The models this sample was run on, when the caller knows them; the one the caller named is first.
  const candidates = [...new Set([props.modelId, ...(props.candidates ?? [])])].filter((id): id is string => Boolean(id));
  const [modelId, setModelId] = useState<string | null>(props.modelId);
  const [answer, setAnswer] = useState<Answer>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");
  const [layer, setLayer] = useState("6");
  const nameOf = (id: string | null) => {
    const model = models.find((item) => item.id === id);
    return model ? model.name || model.source : "the run's model";
  };

  async function compare() {
    setBusy(true);
    try {
      setAnswer({ kind: "view", view: await service.activations(projectId, runId, sampleId, modelId) });
    } catch (error) {
      setAnswer(unavailable(error));
    } finally {
      setBusy(false);
    }
  }

  async function patch() {
    if (!source || !modelId) return;
    setBusy(true);
    try {
      setAnswer({ kind: "view", view: await service.intervene(projectId, { runId, sampleId, sourceModelId: source, targetModelId: modelId, layer: Number(layer) }) });
    } catch (error) {
      setAnswer(unavailable(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lab-inside">
      <div className="lab-muted">Runs with the Python the experiment's command names, in float32. The result is saved with the run and answered from there when asked again.</div>
      <div className="lab-inside-patch">
        {candidates.length > 1 ? (
          <label className="lab-field">
            Model
            <select value={modelId ?? ""} onChange={(event) => { setModelId(event.target.value || null); setAnswer(null); }}>
              {candidates.map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" className="lab-button" disabled={busy} onClick={() => void compare()}>
          {busy ? "Running…" : "Read activations at every layer"}
        </button>
      </div>
      <div className="lab-inside-patch">
        <label className="lab-field">
          Patch layer
          <input value={layer} inputMode="numeric" onChange={(event) => setLayer(event.target.value.replace(/\D/g, ""))} />
        </label>
        <label className="lab-field">
          From
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">Choose a model</option>
            {models.filter((model) => model.id !== modelId).map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || model.source}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="lab-button" disabled={busy || !source || !modelId || !layer} onClick={() => void patch()}>
          Patch into {nameOf(modelId)}
        </button>
      </div>
      {answer?.kind === "unavailable" ? <div className="lab-notice">{answer.reason}</div> : null}
      {answer?.kind === "view" ? (
        <>
          <ActivationGrid caption={`${answer.view.measure}, layer by token${answer.view.top !== undefined ? `; the model ends on ${JSON.stringify(answer.view.top)}` : ""}`} tokens={answer.view.tokens} layers={answer.view.layers} />
          {answer.view.patched ? (
            <ActivationGrid caption={`The same with the residual stream after layer ${answer.view.patched.layer} taken from ${nameOf(answer.view.patched.sourceModelId)}, so layers up to ${answer.view.patched.layer} are its and the rest stay; it then ends on ${JSON.stringify(answer.view.patched.top)}`} tokens={answer.view.tokens} layers={answer.view.patched.layers} />
          ) : null}
          {answer.view.recordedAt ? <div className="lab-muted">Recorded {new Date(answer.view.recordedAt).toLocaleString()} and kept with the run.</div> : null}
        </>
      ) : null}
    </div>
  );
}

/** Layers down, tokens across, each cell as dark as its value is large. Numbers are in the title, so nothing rests on color. */
function ActivationGrid(props: { caption: string; tokens: string[]; layers: ActivationView["layers"] }) {
  const view = props;
  const widest = Math.max(...view.layers.flatMap((row) => row.values.map(Math.abs)), Number.EPSILON);
  return (
    <figure className="lab-activations">
      <figcaption className="lab-muted">{props.caption}</figcaption>
      <div className="lab-table-wrap">
        <table className="lab-table lab-activation-table" aria-label={props.caption}>
          <thead>
            <tr>
              <th scope="col">Layer</th>
              {view.tokens.map((token, index) => (
                <th scope="col" key={`${index}-${token}`}>
                  <code>{token}</code>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.layers.map((row) => (
              <tr key={row.layer}>
                <th scope="row">{row.layer}</th>
                {row.values.map((value, index) => (
                  <td key={index} title={`layer ${row.layer}, ${view.tokens[index] ?? index}: ${value.toFixed(3)}`}>
                    <span className="lab-activation-cell" role="img" aria-label={value.toFixed(3)} style={{ opacity: 0.15 + (Math.abs(value) / widest) * 0.85 }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
