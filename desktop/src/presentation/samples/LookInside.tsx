import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { ActivationView, ModelNode } from "../../domain/research.js";
import { Button } from "../ui/base/Button.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { classes } from "../ui/base/classes.js";
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
    <div className="flex flex-col gap-2 py-2.5">
      <div className="text-xs text-muted-foreground">Runs with the Python the experiment's command names, in float32. The result is saved with the run and answered from there when asked again.</div>
      <div className="flex flex-wrap items-end gap-2">
        {candidates.length > 1 ? (
          <Choice label="Model" className="flex-[0_1_160px]" value={modelId ?? ""} options={candidates.map((id) => ({ value: id, label: nameOf(id) }))} onChange={(chosen) => { setModelId(chosen || null); setAnswer(null); }} />
        ) : null}
        <Button variant="outline" disabled={busy} onClick={() => void compare()}>
          {busy ? "Running…" : "Read activations at every layer"}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Patch layer" className="flex-[0_1_160px]">
          <Input value={layer} inputMode="numeric" onChange={(event) => setLayer(event.target.value.replace(/\D/g, ""))} />
        </Field>
        <Choice label="From" className="flex-[0_1_160px]" placeholder="Choose a model" value={source} options={models.filter((model) => model.id !== modelId).map((model) => ({ value: model.id, label: model.name || model.source }))} onChange={setSource} />
        <Button variant="outline" disabled={busy || !source || !modelId || !layer} onClick={() => void patch()}>
          Patch into {nameOf(modelId)}
        </Button>
      </div>
      {answer?.kind === "unavailable" ? <Notice tone="wait">{answer.reason}</Notice> : null}
      {answer?.kind === "view" ? (
        <>
          <ActivationGrid caption={`${answer.view.measure}, layer by token${answer.view.top !== undefined ? `; the model ends on ${JSON.stringify(answer.view.top)}` : ""}`} tokens={answer.view.tokens} layers={answer.view.layers} />
          {answer.view.patched ? (
            <ActivationGrid caption={`The same with the residual stream after layer ${answer.view.patched.layer} taken from ${nameOf(answer.view.patched.sourceModelId)}, so layers up to ${answer.view.patched.layer} are its and the rest stay; it then ends on ${JSON.stringify(answer.view.patched.top)}`} tokens={answer.view.tokens} layers={answer.view.patched.layers} />
          ) : null}
          {answer.view.recordedAt ? <div className="text-xs text-muted-foreground">Recorded {new Date(answer.view.recordedAt).toLocaleString()} and kept with the run.</div> : null}
        </>
      ) : null}
    </div>
  );
}

/** Layers down, tokens across, each cell as dark as its value is large. Numbers are in the title, so nothing rests on color. */
export function ActivationGrid(props: { caption: string; tokens: string[]; layers: ActivationView["layers"]; signed?: boolean; quietAtOrBelow?: number }) {
  const view = props;
  const widest = Math.max(...view.layers.flatMap((row) => row.values.map(Math.abs)), Number.EPSILON);
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <figcaption className="text-xs text-muted-foreground">{props.caption}</figcaption>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs" aria-label={props.caption}>
          <thead>
            <tr>
              <th scope="col" className="px-1 py-0.5 text-center font-medium whitespace-nowrap text-muted-foreground">Layer</th>
              {view.tokens.map((token, index) => (
                <th scope="col" key={`${index}-${token}`} className="px-1 py-0.5 text-center font-medium whitespace-nowrap text-muted-foreground">
                  <code>{token}</code>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.layers.map((row) => (
              <tr key={row.layer}>
                <th scope="row" className="px-1 py-0.5 text-center font-medium whitespace-nowrap text-muted-foreground">{row.layer}</th>
                {row.values.map((value, index) => {
                  // No further from zero than the control went, so it says nothing: an outline, not a fill.
                  const quiet = props.quietAtOrBelow !== undefined && Math.abs(value) <= props.quietAtOrBelow;
                  return (
                    <td key={index} title={`layer ${row.layer}, ${view.tokens[index] ?? index}: ${value.toFixed(3)}`} className="border-t border-border px-1 py-0.5 text-center align-top">
                      <span
                        className={classes("inline-block size-[18px] rounded-[3px] bg-primary", props.signed && value < 0 && "bg-destructive", props.signed && value >= 0 && "bg-info", quiet && "border border-input bg-transparent")}
                        role="img"
                        aria-label={value.toFixed(3)}
                        style={{ opacity: quiet ? 1 : 0.15 + (Math.abs(value) / widest) * 0.85 }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
