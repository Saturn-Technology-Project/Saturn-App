import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { restoredByLayer, restores, scorerSaysWrong, type ExperimentRun, type ModelNode, type RunSummary, type SweepView } from "../../domain/research.js";
import { messageOf } from "../ui/Parts.js";

const service = desktop.research;
/** How many wrong samples one sweep takes, the runtime's limit. */
const MOST = 32;

/**
 * Does the mechanism change too? Every layer of one model patched into another, on the samples the scorer marked
 * wrong in the newest run, and how many each layer brings back to the expected token.
 */
export function Mechanism(props: { projectId: string; run: ExperimentRun | null; summary: RunSummary | null; models: ModelNode[]; notify: (message: string) => void; onRecord: (text: string) => Promise<void> }) {
  const { projectId, run, summary, models, notify } = props;
  const measured = (summary?.models ?? []).flatMap((model) => (model.modelId ? [model.modelId] : []));
  const [target, setTarget] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<SweepView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const nameOf = (id: string | null) => {
    const model = models.find((item) => item.id === id);
    return model ? model.name || model.source : (id ?? "?");
  };
  const chosenTarget = target || measured.at(-1) || "";
  const chosenSource = source || measured.filter((id) => id !== chosenTarget).at(-1) || "";

  async function sweep() {
    if (!run || !chosenTarget || !chosenSource) return;
    setBusy("Reading the run's samples…");
    setNote(null);
    try {
      const lines = await service.allSamples(projectId, run.id);
      const wrong = [...new Set(lines.filter((line) => (line.modelId ?? null) === chosenTarget && scorerSaysWrong(line)).map((line) => line.sampleId))];
      if (!wrong.length) {
        setNote(`The scorer marked nothing wrong for ${nameOf(chosenTarget)} in this run.`);
        return;
      }
      if (!lines.some((line) => line.expected !== undefined)) {
        setNote("The samples carry no expected token, so nothing says what restored means. Have the program write expected on each line.");
        return;
      }
      setBusy(`Patching every layer of ${nameOf(chosenSource)} into ${nameOf(chosenTarget)} on ${Math.min(wrong.length, MOST)} samples…`);
      setView(await service.sweep(projectId, { runId: run.id, sampleIds: wrong.slice(0, MOST), sourceModelId: chosenSource, targetModelId: chosenTarget }));
      if (wrong.length > MOST) setNote(`${wrong.length} samples were wrong; the first ${MOST} were swept.`);
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  const totals = view ? restoredByLayer(view) : [];
  const best = totals.length ? totals.indexOf(Math.max(...totals)) : -1;
  const summaryText = view && best >= 0 ? `Patching the residual stream after layer ${view.layers[best]} from ${nameOf(view.sourceModelId)} into ${nameOf(view.targetModelId)} restores ${totals[best]} of ${view.samples.length} samples the scorer marked wrong; by layer ${view.layers.join(", ")}: ${totals.join(" ")}.` : "";

  return (
    <div className="lab-card">
      {!run || measured.length < 2 ? (
        <div className="lab-muted">Two measured models are needed: one to patch from, one to patch into. Run an experiment that names at least two.</div>
      ) : (
        <>
          <div className="lab-form">
            <label className="lab-field">
              Patch into
              <select value={chosenTarget} onChange={(event) => setTarget(event.target.value)}>
                {measured.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
              </select>
            </label>
            <label className="lab-field">
              From
              <select value={chosenSource} onChange={(event) => setSource(event.target.value)}>
                {measured.filter((id) => id !== chosenTarget).map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
              </select>
            </label>
            <button type="button" className="lab-button" disabled={Boolean(busy) || !chosenSource} onClick={() => void sweep()}>
              Sweep every layer on what the scorer marked wrong
            </button>
          </div>
          {busy ? <div className="lab-muted">{busy}</div> : null}
          {note ? <div className="lab-notice">{note}</div> : null}
          {view ? (
            <>
              <div className="lab-table-wrap">
                <table className="lab-table lab-activation-table">
                  <thead>
                    <tr>
                      <th scope="col">Sample</th>
                      <th scope="col">Ends on</th>
                      {view.layers.map((layer) => <th scope="col" key={layer}>{layer}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {view.samples.map((sample) => (
                      <tr key={sample.sampleId}>
                        <th scope="row"><code>{sample.sampleId}</code></th>
                        <td><code>{JSON.stringify(sample.top)}</code> <span className="lab-muted">for {JSON.stringify(sample.expected)}</span></td>
                        {view.layers.map((layer) => {
                          const at = sample.byLayer.find((item) => item.layer === layer);
                          return (
                            <td key={layer} title={at ? `layer ${layer}: ends on ${JSON.stringify(at.top)}, log-prob of expected ${at.expectedLogProb ?? "?"}` : ""}>
                              {restores(sample, layer) ? <span className="lab-tag good">✓</span> : <span className="lab-muted">·</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr>
                      <th scope="row">Restored</th>
                      <td className="lab-muted">of {view.samples.length}</td>
                      {totals.map((count, index) => <td key={view.layers[index]}><strong>{count}</strong></td>)}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="lab-muted">A ✓ means the patched model ends on the expected token. Each column takes the residual stream after that layer from the source, so layers up to it are the source's and the rest stay. {view.recordedAt ? `Recorded ${new Date(view.recordedAt).toLocaleString()} and kept with the run.` : ""}</div>
              <button type="button" className="lab-button" onClick={() => void props.onRecord(summaryText)}>
                Record as an observation
              </button>
            </>
          ) : null}
        </>
      )}
      <div className="lab-muted">Features are not compared across models until an alignment method is recorded and tested with an intervention like this one.</div>
    </div>
  );
}
