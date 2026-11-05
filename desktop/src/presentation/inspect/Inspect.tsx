import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { controlCeiling, promptPatchText, readingDifference, restoredByLayer, strongestPatch, type ExperimentRun, type InsideItem, type ModelCompareView, type ModelNode, type PromptPatchView } from "../../domain/research.js";
import { ActivationGrid } from "../samples/LookInside.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Empty, messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;
const VIEWS = ["Two prompts", "Two models", "Recorded"] as const;
type View = (typeof VIEWS)[number];
const KIND_LABELS: Record<InsideItem["kind"], string> = { reading: "Activations", sweep: "Layer sweep", compare: "Two models", prompts: "Two prompts" };

/** A recorded look inside, with the run it is kept with. */
type Recorded = InsideItem & { runId: string };

/** Inside a model on prompts of your own, and everything already looked at in this project. A run supplies the Python and weights. */
export function Inspect(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(
    async () => {
      const runs = (await service.runs(projectId)).items.filter((run) => run.status === "completed").sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
      const models = (await service.models(projectId)).items;
      const recorded: Recorded[] = [];
      for (const run of runs) for (const item of (await service.insideList(projectId, run.id)).items) recorded.push({ ...item, runId: run.id });
      recorded.sort((left, right) => ((left.recordedAt ?? "") < (right.recordedAt ?? "") ? 1 : -1));
      return { runs, models, recorded };
    },
    props.notify,
  );
  const [view, setView] = useState<View>("Two prompts");
  // A sample the Samples screen sent here; taken once, so the form is the person's afterwards.
  const [sent] = useState(() => {
    const session = service.loadSession(projectId);
    if (session.inspect) service.saveSession(projectId, { ...session, inspect: undefined });
    return session.inspect ?? null;
  });
  const [runId, setRunId] = useState(sent?.runId ?? "");
  const runs = value?.runs ?? [];
  const models = value?.models ?? [];
  const chosenRun = runs.find((run) => run.id === runId) ?? runs[0] ?? null;

  if (value && !runs.length) {
    return (
      <Page title="Inspect" lead="Look inside a model on prompts of your own.">
        <Empty title="No finished run yet">A run says which Python and which weights to use. Run an experiment first.</Empty>
      </Page>
    );
  }

  const record = async (text: string, run: string) => {
    try {
      await service.addFinding(projectId, text, "observation", [run]);
      props.notify("Recorded as an observation.");
    } catch (error) {
      props.notify(messageOf(error));
    }
  };

  return (
    <Page title="Inspect" lead="Look inside a model on prompts of your own. Prompts typed here are one case each, not a measurement: an experiment is what measures.">
      <div className="lab-inside-patch">
        <div className="lab-segments" role="tablist" aria-label="What to look at">
          {VIEWS.map((item) => (
            <button key={item} type="button" role="tab" aria-selected={view === item} className={view === item ? "lab-segment active" : "lab-segment"} onClick={() => setView(item)}>
              {item}{item === "Recorded" && value?.recorded.length ? ` ${value.recorded.length}` : ""}
            </button>
          ))}
        </div>
        {view !== "Recorded" ? (
          <label className="lab-field">
            Python and weights from
            <select value={chosenRun?.id ?? ""} onChange={(event) => setRunId(event.target.value)}>
              {runs.map((run) => <option key={run.id} value={run.id}>{runName(run)}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {view === "Two prompts" && chosenRun ? <TwoPrompts projectId={projectId} run={chosenRun} models={models} sent={sent} notify={props.notify} onDone={refresh} onRecord={record} /> : null}
      {view === "Two models" && chosenRun ? <TwoModels projectId={projectId} run={chosenRun} models={models} sent={sent} notify={props.notify} onDone={refresh} /> : null}
      {view === "Recorded" ? <RecordedList items={value?.recorded ?? []} models={models} /> : null}
    </Page>
  );
}

/** A run as a choice: when it began and its id's end. */
function runName(run: ExperimentRun): string {
  return `${new Date(run.createdAt).toLocaleString()} · ${run.id.slice(-8)}`;
}

/** A model's name, or its id when the project no longer has it. */
function modelName(models: ModelNode[], id: string | null | undefined): string {
  const model = models.find((item) => item.id === id);
  return model ? model.name || model.source : (id ?? "the run's model");
}

/** Chooses a model of the project. */
function ModelChoice(props: { label: string; models: ModelNode[]; value: string; onChange: (id: string) => void }) {
  return (
    <label className="lab-field">
      {props.label}
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">Choose a model</option>
        {props.models.map((model) => <option key={model.id} value={model.id}>{model.name || model.source}</option>)}
      </select>
    </label>
  );
}

type Sent = { modelId: string | null; input: string; expected?: string; alternative?: string } | null;

/** A clean prompt patched into a corrupted one, at every layer and position. */
function TwoPrompts(props: { projectId: string; run: ExperimentRun; models: ModelNode[]; sent: Sent; notify: (message: string) => void; onDone: () => Promise<void> | void; onRecord: (text: string, run: string) => Promise<void> }) {
  const [modelId, setModelId] = useState(props.sent?.modelId ?? "");
  const [clean, setClean] = useState(props.sent?.input ?? "");
  const [corrupted, setCorrupted] = useState("");
  const [expected, setExpected] = useState(props.sent?.expected ?? "");
  const [alternative, setAlternative] = useState(props.sent?.alternative ?? "");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<PromptPatchView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setProblem(null);
    try {
      setAnswer(await service.patchPrompts(props.projectId, props.run.id, { modelId, clean, corrupted, expected, alternative }));
      await props.onDone();
    } catch (error) {
      setAnswer(null);
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="lab-card lab-inspect-card">
      <h2>Where does the answer come from?</h2>
      <div className="lab-muted">The corrupted prompt runs with one layer and position restored from the clean prompt at a time. Both need the same number of tokens, so change a word for a word.</div>
      <div className="lab-inspect-prompts">
        <label className="lab-field">Clean prompt<textarea value={clean} placeholder="When Mary and John went to the store, John gave a drink to" onChange={(event) => setClean(event.target.value)} /></label>
        <label className="lab-field">Corrupted prompt<textarea value={corrupted} placeholder="When Mary and John went to the store, Mary gave a drink to" onChange={(event) => setCorrupted(event.target.value)} /></label>
      </div>
      <div className="lab-inside-patch">
        <ModelChoice label="Model" models={props.models} value={modelId} onChange={setModelId} />
        <label className="lab-field">Expected word<input value={expected} placeholder=" Mary" onChange={(event) => setExpected(event.target.value)} /></label>
        <label className="lab-field">Against<input value={alternative} placeholder=" John" onChange={(event) => setAlternative(event.target.value)} /></label>
        <button type="button" className="lab-button" disabled={busy || !modelId || !clean.trim() || !corrupted.trim() || !expected || !alternative} onClick={() => void run()}>
          {busy ? "Patching…" : "Patch every layer and position"}
        </button>
      </div>
      <div className="lab-muted">Spaces count: a name in the middle of a sentence usually starts with one.</div>
      {problem ? <div className="lab-notice">{problem}</div> : null}
      {answer ? <PatchResult view={answer} models={props.models} onRecord={(text) => props.onRecord(text, props.run.id)} /> : null}
    </section>
  );
}

/** What a patch across prompts brought back, read against its control. */
function PatchResult(props: { view: PromptPatchView; models: ModelNode[]; onRecord?: (text: string) => Promise<void> }) {
  const { view } = props;
  const ceiling = controlCeiling(view);
  const best = strongestPatch(view);
  const toRows = (rows: number[][]) => rows.map((values, index) => ({ layer: view.layers[index] ?? index, values }));
  return (
    <>
      <div>
        {best ? `Layer ${best.layer} at ${JSON.stringify(best.token)} brings back ${(best.recovery * 100).toFixed(1)}%.` : "No layer and position brought back more than the control."}{" "}
        <span className="lab-muted">A random change of the same size moved at most {(ceiling * 100).toFixed(1)}%.</span>
      </div>
      <div className="lab-muted">Clean ends on {JSON.stringify(view.cleanTop)}, margin {view.cleanMargin}. Corrupted ends on {JSON.stringify(view.corruptedTop)}, margin {view.corruptedMargin}.</div>
      <ActivationGrid signed quietAtOrBelow={ceiling} caption="How much of the margin comes back, layer by token. Blue brings it back, red pushes it away, an outline is no further than the control went." tokens={view.tokens} layers={toRows(view.recovery)} />
      <details>
        <summary className="lab-muted">The control</summary>
        <ActivationGrid signed caption="The same places given a random change of the same size as the difference between the prompts." tokens={view.tokens} layers={toRows(view.control)} />
      </details>
      {props.onRecord ? <button type="button" className="lab-button" onClick={() => void props.onRecord?.(promptPatchText(view, modelName(props.models, view.modelId)))}>Record as an observation</button> : null}
    </>
  );
}

/** Two models read on one prompt, and where they differ. */
function TwoModels(props: { projectId: string; run: ExperimentRun; models: ModelNode[]; sent: Sent; notify: (message: string) => void; onDone: () => Promise<void> | void }) {
  const parentOf = (id: string | null | undefined) => props.models.find((model) => model.id === id)?.parentId ?? "";
  const [modelId, setModelId] = useState(props.sent?.modelId ?? "");
  const [otherModelId, setOtherModelId] = useState(parentOf(props.sent?.modelId));
  const [input, setInput] = useState(props.sent?.input ?? "");
  const [expected, setExpected] = useState(props.sent?.expected ?? "");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ModelCompareView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Choosing a child offers its parent, the comparison most often wanted.
  useEffect(() => {
    if (!otherModelId && modelId) setOtherModelId(parentOf(modelId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  async function run() {
    setBusy(true);
    setProblem(null);
    try {
      setAnswer(await service.compareModels(props.projectId, props.run.id, { modelId, otherModelId, input, ...(expected ? { expected } : {}) }));
      await props.onDone();
    } catch (error) {
      setAnswer(null);
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="lab-card lab-inspect-card">
      <h2>Where do two models part?</h2>
      <label className="lab-field">Prompt<textarea value={input} placeholder="When Mary and John went to the store, John gave a drink to" onChange={(event) => setInput(event.target.value)} /></label>
      <div className="lab-inside-patch">
        <ModelChoice label="Model" models={props.models} value={modelId} onChange={setModelId} />
        <ModelChoice label="Against" models={props.models.filter((model) => model.id !== modelId)} value={otherModelId} onChange={setOtherModelId} />
        <label className="lab-field">Expected word, if any<input value={expected} placeholder=" Mary" onChange={(event) => setExpected(event.target.value)} /></label>
        <button type="button" className="lab-button" disabled={busy || !modelId || !otherModelId || !input.trim()} onClick={() => void run()}>
          {busy ? "Reading…" : "Read both"}
        </button>
      </div>
      {problem ? <div className="lab-notice">{problem}</div> : null}
      {answer ? <CompareResult view={answer} models={props.models} /> : null}
    </section>
  );
}

/** Both readings, and the first less the second. */
function CompareResult(props: { view: ModelCompareView; models: ModelNode[] }) {
  const { view, models } = props;
  const name = modelName(models, view.modelId);
  const other = modelName(models, view.otherModelId);
  return (
    <>
      <div className="lab-muted">{view.measure}. {name} ends on {JSON.stringify(view.top)}, {other} on {JSON.stringify(view.otherTop)}.</div>
      <ActivationGrid signed caption={`${name} less ${other}. Blue is higher in ${name}, red in ${other}.`} tokens={view.tokens} layers={readingDifference(view.layers, view.otherLayers)} />
      <ActivationGrid caption={name} tokens={view.tokens} layers={view.layers} />
      <ActivationGrid caption={other} tokens={view.tokens} layers={view.otherLayers} />
    </>
  );
}

/** Everything looked at in this project, newest first, wherever it was asked. */
function RecordedList(props: { items: Recorded[]; models: ModelNode[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const keyOf = (item: Recorded) => `${item.runId}:${item.key ?? item.recordedAt}`;
  if (!props.items.length) return <Empty title="Nothing recorded yet">What you and the assistant look at inside a model is kept here, with the run it used.</Empty>;
  return (
    <section className="lab-card lab-inspect-card lab-inspect-history">
      {props.items.map((item) => {
        const key = keyOf(item);
        return (
          <details key={key} open={open === key} onToggle={(event) => { if (event.currentTarget.open) setOpen(key); else if (open === key) setOpen(null); }}>
            <summary>
              {KIND_LABELS[item.kind]} <span className="lab-muted">{describe(item, props.models)} · {item.recordedAt ? new Date(item.recordedAt).toLocaleString() : ""}{item.current === false ? " · by an earlier helper" : ""}</span>
            </summary>
            {open === key ? <RecordedItem item={item} models={props.models} /> : null}
          </details>
        );
      })}
    </section>
  );
}

/** One line on what a recorded look was at. */
function describe(item: Recorded, models: ModelNode[]): string {
  if (item.kind === "sweep") return `${modelName(models, item.sourceModelId)} into ${modelName(models, item.targetModelId)}, ${item.samples.length} samples`;
  if (item.kind === "compare") return `${modelName(models, item.modelId)} against ${modelName(models, item.otherModelId)}`;
  if (item.kind === "prompts") return modelName(models, item.modelId);
  return `${modelName(models, item.modelId)} on ${item.sampleId}`;
}

/** A recorded look, as it was seen. */
function RecordedItem(props: { item: Recorded; models: ModelNode[] }) {
  const { item, models } = props;
  if (item.kind === "prompts") return <PatchResult view={item} models={models} />;
  if (item.kind === "compare") return <CompareResult view={item} models={models} />;
  if (item.kind === "sweep") {
    const totals = restoredByLayer(item);
    return <div className="lab-muted">Restored of {item.samples.length}, by layer {item.layers.join(", ")}: {totals.join(" ")}. The Experiments screen shows it sample by sample.</div>;
  }
  return <ActivationGrid caption={item.measure} tokens={item.tokens} layers={item.layers} />;
}
