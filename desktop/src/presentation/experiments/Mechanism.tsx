import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { RESTORE_MEASURE_TEXT, restoredByLayer, restores, scorerSaysWrong, sweepMeasure, type ExperimentRun, type ModelNode, type RunSummary, type SweepView } from "../../domain/research.js";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { Choice } from "../ui/base/Field.js";
import { Notice } from "../ui/base/Notice.js";
import { classes } from "../ui/base/classes.js";
import { messageOf } from "../ui/Parts.js";

const service = desktop.research;
/** How many wrong samples one sweep takes, the runtime's limit. */
const MOST = 32;
/** Small quiet text. */
const MUTED = "text-xs text-muted-foreground";
/** A heading cell and a body cell of the table that shows which layer brings each sample back. */
const HEAD_CELL = "px-1 py-0.5 text-center font-medium whitespace-nowrap text-muted-foreground";
const BODY_CELL = "border-t border-border px-1 py-0.5 text-center align-top";

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

  const measure = view ? sweepMeasure(view) : "top";
  const totals = view ? restoredByLayer(view, measure) : [];
  const topTotals = view && measure === "margin" ? restoredByLayer(view, "top") : null;
  const best = totals.length ? totals.indexOf(Math.max(...totals)) : -1;
  const summaryText = view && best >= 0 ? `Patching the residual stream after layer ${view.layers[best]} from ${nameOf(view.sourceModelId)} into ${nameOf(view.targetModelId)} restores ${totals[best]} of ${view.samples.length} samples the scorer marked wrong ${RESTORE_MEASURE_TEXT[measure]}; by layer ${view.layers.join(", ")}: ${totals.join(" ")}.${topTotals ? ` By top token: ${topTotals.join(" ")}.` : ""}` : "";

  return (
    <Card className="gap-2.5 border-0 bg-panel px-3.5 py-3">
      {!run || measured.length < 2 ? (
        <div className={MUTED}>Two measured models are needed: one to patch from, one to patch into. Run an experiment that names at least two.</div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Choice label="Patch into" className="flex-[1_1_160px]" value={chosenTarget} options={measured.map((id) => ({ value: id, label: nameOf(id) }))} onChange={setTarget} />
            <Choice label="From" className="flex-[1_1_160px]" value={chosenSource} options={measured.filter((id) => id !== chosenTarget).map((id) => ({ value: id, label: nameOf(id) }))} onChange={setSource} />
            <Button variant="outline" data-tour="experiments-sweep" disabled={Boolean(busy) || !chosenSource} onClick={() => void sweep()}>
              Sweep every layer on what the scorer marked wrong
            </Button>
          </div>
          {busy ? <div className={MUTED}>{busy}</div> : null}
          {note ? <Notice tone="wait">{note}</Notice> : null}
          {view ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs" aria-label="Which layer brings each sample back">
                  <thead>
                    <tr>
                      <th scope="col" className={HEAD_CELL}>Sample</th>
                      <th scope="col" className={HEAD_CELL}>Ends on</th>
                      {view.layers.map((layer) => <th scope="col" key={layer} className={HEAD_CELL}>{layer}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {view.samples.map((sample) => (
                      <tr key={sample.sampleId}>
                        <th scope="row" className={HEAD_CELL}><code>{sample.sampleId}</code></th>
                        <td className={BODY_CELL}><code>{JSON.stringify(sample.top)}</code> <span className={MUTED}>for {JSON.stringify(sample.expected)}</span></td>
                        {view.layers.map((layer) => {
                          const at = sample.byLayer.find((item) => item.layer === layer);
                          return (
                            <td key={layer} className={BODY_CELL} title={at ? `layer ${layer}: ends on ${JSON.stringify(at.top)}, log-prob of expected ${at.expectedLogProb ?? "?"}${typeof at.margin === "number" ? `, margin ${at.margin}` : ""}` : ""}>
                              {restores(sample, layer, measure) ? <Badge tone="good" role="img" aria-label="restored">✓</Badge> : <span className={MUTED} role="img" aria-label="not restored">·</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr>
                      <th scope="row" className={HEAD_CELL}>Restored</th>
                      <td className={classes(BODY_CELL, MUTED)}>of {view.samples.length}, {RESTORE_MEASURE_TEXT[measure]}</td>
                      {totals.map((count, index) => <td key={view.layers[index]} className={BODY_CELL}><strong>{count}</strong></td>)}
                    </tr>
                    {topTotals ? (
                      <tr>
                        <th scope="row" className={HEAD_CELL}>Top token</th>
                        <td className={classes(BODY_CELL, MUTED)}>of {view.samples.length}</td>
                        {topTotals.map((count, index) => <td key={view.layers[index]} className={BODY_CELL}>{count}</td>)}
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <div className={MUTED}>{measure === "margin" ? "A ✓ means the patched model puts the expected word ahead of its alternative, which is what a two-way scorer judges; it may still end on another word." : "A ✓ means the patched model ends on the expected token. Have the program write alternative on each line to count the margin a two-way scorer judges."} Each column takes the residual stream after that layer from the source, so layers up to it are the source's and the rest stay. {view.recordedAt ? `Recorded ${new Date(view.recordedAt).toLocaleString()} and kept with the run.` : ""}</div>
              <Button variant="outline" className="w-fit" onClick={() => void props.onRecord(summaryText)}>
                Record as an observation
              </Button>
            </>
          ) : null}
        </>
      )}
      <div className={MUTED}>Features are not compared across models until an alignment method is recorded and tested with an intervention like this one.</div>
    </Card>
  );
}
