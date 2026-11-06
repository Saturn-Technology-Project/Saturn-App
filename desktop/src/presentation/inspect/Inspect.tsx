import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import { ablationText, controlCeiling, featurePeaks, featuresText, promptPatchText, readingDifference, reconstructionIsPoor, restoredByLayer, signedText, strongestPatch, type ExperimentRun, type FeaturesView, type InsideItem, type ModelCompareView, type ModelNode, type PromptPatchView } from "../../domain/research.js";
import { ActivationGrid } from "../samples/LookInside.js";
import { Button } from "../ui/base/Button.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Tabs, TabsList, TabsTrigger } from "../ui/base/Tabs.js";
import { Textarea } from "../ui/base/Textarea.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Empty, messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";
import { InspectionSessionBuilder } from "./InspectionSession.js";
import { Artifacts } from "../experiments/Artifacts.js";

const service = desktop.research;
const VIEWS = ["Two prompts", "Two models", "Features", "Recorded"] as const;
type View = (typeof VIEWS)[number];
/** Each view's name, as it is shown. */
const VIEW_LABELS: Record<View, string> = { "Two prompts": t("Two prompts"), "Two models": t("Two models"), Features: t("Features"), Recorded: t("Recorded") };
const KIND_LABELS: Record<InsideItem["kind"], string> = { reading: t("Activations"), sweep: t("Layer sweep"), compare: t("Two models"), prompts: t("Two prompts"), features: t("Features") };
/** A finding's kind, as it is shown. */
const FINDING_LABELS: Record<string, string> = { observation: t("Observation"), ai_suggestion: t("AI suggestion"), conclusion: t("Conclusion") };

/** A recorded look inside, with the run it is kept with. */
type Recorded = InsideItem & { runId: string };
/** A run or a standalone session supplies immutable model references to the same analysis controls. */
type InspectionSource = Pick<ExperimentRun, "id" | "createdAt"> & { title?: string };

/** Inside a model on prompts of your own, and everything already looked at in this project. A run supplies the Python and weights. */
export function Inspect(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(
    async () => {
      const completed = (await service.runs(projectId)).items.filter((run) => run.status === "completed");
      const sessions = (await service.inspectionSessions(projectId)).items;
      const runs: InspectionSource[] = [...completed, ...sessions].sort((left, right) => left.createdAt < right.createdAt ? 1 : -1);
      const findings = (await service.findings(projectId)).items;
      const models = (await service.models(projectId)).items;
      const recorded: Recorded[] = [];
      for (const run of runs) for (const item of (await service.insideList(projectId, run.id)).items) recorded.push({ ...item, runId: run.id });
      recorded.sort((left, right) => ((left.recordedAt ?? "") < (right.recordedAt ?? "") ? 1 : -1));
      return { runs, models, recorded, sessions, findings };
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

  const session = value?.sessions.find((item) => item.id === chosenRun?.id);
  const availableModels = session ? models.filter((model) => session.models.some((snapshot) => snapshot.modelId === model.id)).map((model) => {
    const snapshot = session.models.find((item) => item.modelId === model.id)!;
    return { ...model, source: snapshot.source, weightsRevision: snapshot.weightsRevision ?? undefined, name: snapshot.name || model.name };
  }) : models;

  const record = async (text: string, run: string) => {
    try {
      await service.addFinding(projectId, text, "observation", run.startsWith("inspection_") ? [] : [run], run.startsWith("inspection_") ? [run] : undefined);
      await refresh();
      props.notify(t("Recorded as an observation."));
    } catch (error) {
      props.notify(messageOf(error));
    }
  };

  return (
    <Page title={t("Inspect")} lead={t("Look inside a model on prompts of your own. Prompts typed here are one case each, not a measurement: an experiment is what measures.")}>
      <InspectionSessionBuilder projectId={projectId} models={models} notify={props.notify} go={props.go} onCreated={(id) => { setRunId(id); void refresh(); }} />
      {session ? <p className="my-2 text-xs text-muted-foreground">{t("Session Python: {python}. Models: {models}.", { python: session.python, models: session.models.map((model) => `${model.name || model.source} @ ${model.weightsRevision || t("floating")}`).join(", ") })} {session.note}</p> : null}
      {!runs.length ? <p className="my-2 text-sm text-muted-foreground">{t("Start an inspection session above, or use a completed experiment's Python and model references.")}</p> : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Tabs value={view} onValueChange={(item) => setView(item as View)}>
          <TabsList aria-label={t("What to look at")}>
            {VIEWS.map((item) => (
              <TabsTrigger key={item} value={item}>
                {VIEW_LABELS[item]}{item === "Recorded" && value?.recorded.length ? ` ${value.recorded.length}` : ""}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {view !== "Recorded" ? <Choice label={t("Python and weights from")} className="w-56" value={chosenRun?.id ?? ""} options={runs.map((run) => ({ value: run.id, label: runName(run) }))} onChange={setRunId} /> : null}
      </div>
      {view === "Two prompts" && chosenRun ? <TwoPrompts projectId={projectId} run={chosenRun} models={availableModels} sent={sent} notify={props.notify} onDone={refresh} onRecord={record} /> : null}
      {view === "Two models" && chosenRun ? <TwoModels projectId={projectId} run={chosenRun} models={availableModels} sent={sent} notify={props.notify} onDone={refresh} /> : null}
      {view === "Features" && chosenRun ? <Features projectId={projectId} run={chosenRun} models={availableModels} sent={sent} onDone={refresh} onRecord={record} /> : null}
      {view === "Recorded" ? <RecordedList items={value?.recorded ?? []} models={models} /> : null}
      {session ? <Artifacts key={session.id} projectId={projectId} inspectionId={session.id} notify={props.notify} go={props.go} /> : null}
      {session?.archived ? <Notice tone="wait">{t("This is archived evidence. Create a new inspection session with this machine's Python and models to compute new results.")}</Notice> : null}
      {session ? value?.findings.filter((finding) => finding.inspectionIds?.includes(session.id)).map((finding) => <div key={finding.id} className="my-2 rounded-lg bg-panel p-3 text-sm"><span className="text-xs text-muted-foreground">{FINDING_LABELS[finding.kind] ?? finding.kind}: </span>{finding.text}</div>) : null}
    </Page>
  );
}

/** A run as a choice: when it began and its id's end. */
function runName(run: InspectionSource): string {
  return `${run.title ? t("Session: {title}", { title: run.title }) : t("Run")} · ${new Date(run.createdAt).toLocaleString()} · ${run.id.slice(-8)}`;
}

/** A model's name, or its id when the project no longer has it. */
function modelName(models: ModelNode[], id: string | null | undefined): string {
  const model = models.find((item) => item.id === id);
  return model ? model.name || model.source : (id ?? t("the run's model"));
}

/** Chooses a model of the project. */
function ModelChoice(props: { label: string; models: ModelNode[]; value: string; onChange: (id: string) => void }) {
  const options = props.models.map((model) => ({ value: model.id, label: model.name || model.source }));
  return <Choice label={props.label} className="w-44" placeholder={t("Choose a model")} value={props.value} options={options} onChange={props.onChange} />;
}

type Sent = { modelId: string | null; input: string; expected?: string; alternative?: string } | null;

/** A clean prompt patched into a corrupted one, at every layer and position. */
function TwoPrompts(props: { projectId: string; run: InspectionSource; models: ModelNode[]; sent: Sent; notify: (message: string) => void; onDone: () => Promise<void> | void; onRecord: (text: string, run: string) => Promise<void> }) {
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
    <section className="mt-3 flex flex-col gap-3 rounded-lg bg-card p-4">
      <h2 className="mt-0! text-sm font-semibold">{t("Where does the answer come from?")}</h2>
      <div className="text-xs text-muted-foreground">{t("The corrupted prompt runs with one layer and position restored from the clean prompt at a time. Both need the same number of tokens, so change a word for a word.")}</div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
        <Field label={t("Clean prompt")}><Textarea value={clean} placeholder="When Mary and John went to the store, John gave a drink to" onChange={(event) => setClean(event.target.value)} /></Field>
        <Field label={t("Corrupted prompt")}><Textarea value={corrupted} placeholder="When Mary and John went to the store, Mary gave a drink to" onChange={(event) => setCorrupted(event.target.value)} /></Field>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <ModelChoice label={t("Model")} models={props.models} value={modelId} onChange={setModelId} />
        <Field label={t("Expected word")} className="w-32"><Input value={expected} placeholder=" Mary" onChange={(event) => setExpected(event.target.value)} /></Field>
        <Field label={t("Against")} className="w-32"><Input value={alternative} placeholder=" John" onChange={(event) => setAlternative(event.target.value)} /></Field>
        <Button disabled={busy || !modelId || !clean.trim() || !corrupted.trim() || !expected || !alternative} onClick={() => void run()}>
          {busy ? t("Patching…") : t("Patch every layer and position")}
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">{t("Spaces count: a name in the middle of a sentence usually starts with one.")}</div>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
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
        {best ? t("Layer {layer} at {token} brings back {share}%.", { layer: best.layer, token: JSON.stringify(best.token), share: (best.recovery * 100).toFixed(1) }) : t("No layer and position brought back more than the control.")}{" "}
        <span className="text-xs text-muted-foreground">{t("A random change of the same size moved at most {share}%.", { share: (ceiling * 100).toFixed(1) })}</span>
      </div>
      <div className="text-xs text-muted-foreground">{t("Clean ends on {cleanTop}, margin {cleanMargin}. Corrupted ends on {corruptedTop}, margin {corruptedMargin}.", { cleanTop: JSON.stringify(view.cleanTop), cleanMargin: view.cleanMargin, corruptedTop: JSON.stringify(view.corruptedTop), corruptedMargin: view.corruptedMargin })}</div>
      <ActivationGrid signed quietAtOrBelow={ceiling} caption={t("How much of the margin comes back, layer by token. Blue brings it back, red pushes it away, an outline is no further than the control went.")} tokens={view.tokens} layers={toRows(view.recovery)} />
      <details>
        <summary className="text-xs text-muted-foreground">{t("The control")}</summary>
        <ActivationGrid signed caption={t("The same places given a random change of the same size as the difference between the prompts.")} tokens={view.tokens} layers={toRows(view.control)} />
      </details>
      {props.onRecord ? <Button variant="outline" className="w-fit" onClick={() => void props.onRecord?.(promptPatchText(view, modelName(props.models, view.modelId)))}>{t("Record as an observation")}</Button> : null}
    </>
  );
}

/** Two models read on one prompt, and where they differ. */
function TwoModels(props: { projectId: string; run: InspectionSource; models: ModelNode[]; sent: Sent; notify: (message: string) => void; onDone: () => Promise<void> | void }) {
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
    <section className="mt-3 flex flex-col gap-3 rounded-lg bg-card p-4">
      <h2 className="mt-0! text-sm font-semibold">{t("Where do two models part?")}</h2>
      <Field label={t("Prompt")}><Textarea value={input} placeholder="When Mary and John went to the store, John gave a drink to" onChange={(event) => setInput(event.target.value)} /></Field>
      <div className="flex flex-wrap items-end gap-3">
        <ModelChoice label={t("Model")} models={props.models} value={modelId} onChange={setModelId} />
        <ModelChoice label={t("Against")} models={props.models.filter((model) => model.id !== modelId)} value={otherModelId} onChange={setOtherModelId} />
        <Field label={t("Expected word, if any")} className="w-40"><Input value={expected} placeholder=" Mary" onChange={(event) => setExpected(event.target.value)} /></Field>
        <Button disabled={busy || !modelId || !otherModelId || !input.trim()} onClick={() => void run()}>
          {busy ? t("Reading…") : t("Read both")}
        </Button>
      </div>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
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
      <div className="text-xs text-muted-foreground">{view.measure}. {t("{name} ends on {top}, {other} on {otherTop}.", { name, top: JSON.stringify(view.top), other, otherTop: JSON.stringify(view.otherTop) })}</div>
      <ActivationGrid signed caption={t("{name} less {other}. Blue is higher in {name}, red in {other}.", { name, other })} tokens={view.tokens} layers={readingDifference(view.layers, view.otherLayers)} />
      <ActivationGrid caption={name} tokens={view.tokens} layers={view.layers} />
      <ActivationGrid caption={other} tokens={view.tokens} layers={view.otherLayers} />
    </>
  );
}

/** Where an SAE comes from: a release of SAELens, or a folder. */
const SAE_SOURCES = [{ value: "release", label: t("SAELens release") }, { value: "path", label: t("Local folder") }];

/** One layer on one prompt read through a sparse autoencoder, with one feature set to zero if asked. */
function Features(props: { projectId: string; run: InspectionSource; models: ModelNode[]; sent: Sent; onDone: () => Promise<void> | void; onRecord: (text: string, run: string) => Promise<void> }) {
  const [modelId, setModelId] = useState(props.sent?.modelId ?? "");
  const [prompt, setPrompt] = useState(props.sent?.input ?? "");
  const [layer, setLayer] = useState("");
  const [source, setSource] = useState("release");
  const [release, setRelease] = useState("");
  const [saeId, setSaeId] = useState("");
  const [path, setPath] = useState("");
  const [expected, setExpected] = useState(props.sent?.expected ?? "");
  const [alternative, setAlternative] = useState(props.sent?.alternative ?? "");
  const [ablate, setAblate] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<FeaturesView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const named = source === "path" ? Boolean(path.trim()) : Boolean(release.trim() && saeId.trim());
  const margin = Boolean(expected && alternative);

  async function run() {
    setBusy(true);
    setProblem(null);
    try {
      setAnswer(await service.readFeatures(props.projectId, props.run.id, {
        modelId,
        prompt,
        layer: Number(layer),
        ...(source === "path" ? { saePath: path.trim() } : { saeRelease: release.trim(), saeId: saeId.trim() }),
        ...(margin ? { expected, alternative } : {}),
        ...(margin && ablate ? { ablate: Number(ablate) } : {}),
      }));
      await props.onDone();
    } catch (error) {
      setAnswer(null);
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-3 flex flex-col gap-3 rounded-lg bg-card p-4">
      <h2 className="mt-0! text-sm font-semibold">{t("What does a sparse autoencoder find at this layer?")}</h2>
      <div className="text-xs text-muted-foreground">{t("The SAE must have been made for this model's residual stream. Layer counts as in a patch: layer 7 is the stream leaving block 7, which SAELens calls blocks.8.hook_resid_pre or blocks.7.hook_resid_post.")}</div>
      <Field label={t("Prompt")}><Textarea value={prompt} placeholder="When Mary and John went to the store, John gave a drink to" onChange={(event) => setPrompt(event.target.value)} /></Field>
      <div className="flex flex-wrap items-end gap-3">
        <ModelChoice label={t("Model")} models={props.models} value={modelId} onChange={setModelId} />
        <Field label={t("Layer")} className="w-20"><Input value={layer} inputMode="numeric" placeholder="7" onChange={(event) => setLayer(event.target.value.replace(/\D/g, ""))} /></Field>
        <Choice label={t("SAE from")} className="w-40" value={source} options={SAE_SOURCES} onChange={setSource} />
        {source === "path" ? (
          <Field label={t("Folder")} className="w-72"><Input value={path} placeholder="saes/layer-7" onChange={(event) => setPath(event.target.value)} /></Field>
        ) : (
          <>
            <Field label={t("Release")} className="w-44"><Input value={release} placeholder="gpt2-small-res-jb" onChange={(event) => setRelease(event.target.value)} /></Field>
            <Field label={t("SAE id")} className="w-52"><Input value={saeId} placeholder="blocks.8.hook_resid_pre" onChange={(event) => setSaeId(event.target.value)} /></Field>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("Expected word, if any")} className="w-40"><Input value={expected} placeholder=" Mary" onChange={(event) => setExpected(event.target.value)} /></Field>
        <Field label={t("Against")} className="w-32"><Input value={alternative} placeholder=" John" onChange={(event) => setAlternative(event.target.value)} /></Field>
        <Field label={t("Feature to ablate, if any")} className="w-44"><Input value={ablate} inputMode="numeric" disabled={!margin} placeholder={margin ? t("a feature's id") : t("needs both words")} onChange={(event) => setAblate(event.target.value.replace(/\D/g, ""))} /></Field>
        <Button disabled={busy || !modelId || !prompt.trim() || !layer || !named || Boolean(expected) !== Boolean(alternative)} onClick={() => void run()}>
          {busy ? t("Reading…") : ablate && margin ? t("Read and ablate feature {feature}", { feature: ablate }) : t("Read features")}
        </Button>
      </div>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {answer ? <FeaturesResult view={answer} models={props.models} onPick={margin ? (feature) => setAblate(String(feature)) : undefined} onRecord={(text) => props.onRecord(text, props.run.id)} /> : null}
    </section>
  );
}

const CELL = "border-t border-border px-2 py-1 text-left align-top";
const HEAD = "px-2 py-1 text-left font-medium whitespace-nowrap text-muted-foreground";

/** How well a prompt was rebuilt, the features found by id with what activates them here, and an ablation read against its control. */
function FeaturesResult(props: { view: FeaturesView; models: ModelNode[]; onPick?: (feature: number) => void; onRecord?: (text: string) => Promise<void> }) {
  const { view, models } = props;
  const { reconstruction, sae } = view;
  const name = modelName(models, view.modelId);
  const peaks = featurePeaks(view);
  const explained = reconstruction.varianceExplained;
  return (
    <>
      <div>
        {explained === null ? t("One token has no variance to explain.") : t("The SAE explains {share}% of the variance on this prompt.", { share: (explained * 100).toFixed(1) })}{" "}
        <span className="text-xs text-muted-foreground">{t("Relative error {error}, {count} features active per token. {name} ends on {top}.", { error: reconstruction.relativeError, count: reconstruction.meanActiveFeatures, name, top: JSON.stringify(view.top) })}</span>
      </div>
      {reconstructionIsPoor(view) ? <Notice tone="wait">{t("This SAE rebuilds the prompt poorly, so its features say little here. It may have been made for other weights.")}</Notice> : null}
      <div className="text-xs text-muted-foreground">
        {sae.path ?? `${sae.release} / ${sae.id}`}: {sae.trainedOn ? t("reads {hook}, {width} features, trained on {data}.", { hook: sae.hookName, width: sae.width, data: sae.trainedOn }) : t("reads {hook}, {width} features.", { hook: sae.hookName, width: sae.width })}
        {sae.startTokenAdded ? ` ${t("A start token was added, as it was trained with.")}` : ""}
        {sae.centered ? ` ${t("The stream's mean over dimensions was removed, as it was trained without; the model's LayerNorms ignore it.")}` : ""}
        {reconstruction.tokensLeftOut ? ` ${reconstruction.tokensLeftOut === 1 ? t("1 special token is left out and left as it was.") : t("{count} special tokens are left out and left as they were.", { count: reconstruction.tokensLeftOut })}` : ""}
      </div>
      <FeatureEffects view={view} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs" aria-label={t("The strongest features at each token")}>
          <thead><tr><th scope="col" className={HEAD}>{t("Token")}</th><th scope="col" className={HEAD}>{t("Strongest features, with activation")}</th></tr></thead>
          <tbody>
            {view.tokens.map((token, position) => (
              <tr key={`${position}-${token}`}>
                <th scope="row" className={`${CELL} font-medium whitespace-nowrap`}><code>{token}</code></th>
                <td className={CELL}>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {view.features[position]?.length ? view.features[position].map(({ feature, activation }) => (
                      <span key={feature} className="whitespace-nowrap">
                        {props.onPick ? <button type="button" className="text-foreground underline underline-offset-2" aria-label={t("Choose feature {feature} to ablate", { feature })} onClick={() => props.onPick?.(feature)}>{feature}</button> : feature}{" "}
                        <span className="text-muted-foreground">{activation.toFixed(1)}</span>
                      </span>
                    )) : <span className="text-muted-foreground">{t("Not read")}</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary className="text-xs text-muted-foreground">{t("Each feature, and what activates it here")}</summary>
        <div className="mt-1 flex flex-col gap-0.5 text-xs">
          {peaks.map((item) => <div key={item.feature}>{item.feature} <span className="text-muted-foreground">{t("peaks at {peak}, at {tokens}", { peak: item.peak.toFixed(1), tokens: item.tokens.map((token) => JSON.stringify(token)).join(", ") })}</span></div>)}
        </div>
      </details>
      <div className="text-xs text-muted-foreground">{t("A feature here is its number and the tokens above, not a name: a label would be a guess until it is tested. Numbers belong to this SAE on these weights, so features are not compared across models. One prompt is one case, not a measurement.")}</div>
      {props.onRecord ? <Button variant="outline" className="w-fit" onClick={() => void props.onRecord?.(featuresText(view, name))}>{t("Record as an observation")}</Button> : null}
    </>
  );
}

/** What splicing the reconstruction did to the margin, and a feature set to zero beside its control. */
function FeatureEffects(props: { view: FeaturesView }) {
  const { margins, ablation, expected, alternative } = props.view;
  if (!margins) return null;
  const row = (what: string, margin: number, change: number) => (
    <tr>
      <th scope="row" className={`${CELL} font-medium`}>{what}</th>
      <td className={CELL}>{margin}</td>
      <td className={CELL}>{signedText(change)}</td>
    </tr>
  );
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs" aria-label={t("The margin of {expected} over {alternative}", { expected: expected ?? "", alternative: alternative ?? "" })}>
          <thead>
            <tr>
              <th scope="col" className={HEAD}>{t("Margin of {expected} over {alternative}", { expected: JSON.stringify(expected), alternative: JSON.stringify(alternative) })}</th>
              <th scope="col" className={HEAD}>{t("Margin")}</th>
              <th scope="col" className={HEAD}>{t("Change")}</th>
            </tr>
          </thead>
          <tbody>
            <tr><th scope="row" className={`${CELL} font-medium`}>{t("The model as it is")}</th><td className={CELL}>{margins.plain}</td><td className={CELL} /></tr>
            {row(t("Unmodified reconstruction spliced in, from the model as it is"), margins.spliced, margins.spliceChange)}
            {ablation ? row(t("Feature {feature} set to zero (activation up to {activation}), from the reconstruction", { feature: ablation.feature, activation: ablation.activation }), ablation.margin, ablation.change) : null}
            {ablation?.control ? row(t("Control: random feature {feature} set to zero (activation up to {activation}), from the reconstruction", { feature: ablation.control.feature, activation: ablation.control.activation }), ablation.control.margin, ablation.control.change) : null}
          </tbody>
        </table>
      </div>
      {ablation ? <div>{ablationText(props.view)}</div> : null}
    </>
  );
}

/** Everything looked at in this project, newest first, wherever it was asked. */
function RecordedList(props: { items: Recorded[]; models: ModelNode[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const keyOf = (item: Recorded) => `${item.runId}:${item.key ?? item.recordedAt}`;
  if (!props.items.length) return <Empty title={t("Nothing recorded yet")}>{t("What you and the assistant look at inside a model is kept here, with the run it used.")}</Empty>;
  return (
    <section className="mt-3 flex flex-col gap-0.5 rounded-lg bg-card p-4">
      {props.items.map((item) => {
        const key = keyOf(item);
        return (
          <details key={key} open={open === key} onToggle={(event) => { if (event.currentTarget.open) setOpen(key); else if (open === key) setOpen(null); }}>
            <summary>
              {KIND_LABELS[item.kind]} <span className="text-xs text-muted-foreground">{describe(item, props.models)} · {item.recordedAt ? new Date(item.recordedAt).toLocaleString() : ""}{item.current === false ? ` · ${t("by an earlier helper")}` : ""}</span>
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
  if (item.kind === "sweep") return t("{source} into {target}, {count} samples", { source: modelName(models, item.sourceModelId), target: modelName(models, item.targetModelId), count: item.samples.length });
  if (item.kind === "compare") return t("{model} against {other}", { model: modelName(models, item.modelId), other: modelName(models, item.otherModelId) });
  if (item.kind === "prompts") return modelName(models, item.modelId);
  if (item.kind === "features") return t("{model}, layer {layer}, {sae}", { model: modelName(models, item.modelId), layer: item.layer, sae: item.sae.path ?? `${item.sae.release} / ${item.sae.id}` });
  return t("{model} on {sample}", { model: modelName(models, item.modelId), sample: item.sampleId });
}

/** A recorded look, as it was seen. */
function RecordedItem(props: { item: Recorded; models: ModelNode[] }) {
  const { item, models } = props;
  if (item.kind === "prompts") return <PatchResult view={item} models={models} />;
  if (item.kind === "compare") return <CompareResult view={item} models={models} />;
  if (item.kind === "features") return <FeaturesResult view={item} models={models} />;
  if (item.kind === "sweep") {
    const totals = restoredByLayer(item);
    return <div className="text-xs text-muted-foreground">{t("Restored of {count}, by layer {layers}: {totals}. The Experiments screen shows it sample by sample.", { count: item.samples.length, layers: item.layers.join(", "), totals: totals.join(" ") })}</div>;
  }
  return <ActivationGrid caption={item.measure} tokens={item.tokens} layers={item.layers} />;
}
