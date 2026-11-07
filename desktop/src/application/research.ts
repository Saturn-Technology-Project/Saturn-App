import type {
  AcrossRow,
  WorkerPairing,
  ActivationView,
  FeaturesView,
  ModelCompareView,
  PromptPatchView,
  Comparison,
  EnvironmentRecord,
  InsideItem,
  InterventionRequest,
  OpenTarget,
  ExperimentDraft,
  ExperimentRun,
  Finding,
  FindingKind,
  FrozenVersion,
  Hypothesis,
  ModelNode,
  Question,
  ResearchEvent,
  ResearchPolicy,
  LabelAgreement, RunLabels,
  RunResources,
  RunSummary,
  ResearchSession,
  SampleItem,
  SampleLine,
  SourceView,
  SweepView,
} from "../domain/research.js";
import type { DataList, DataOverlap, DataPage, DataProfile } from "../domain/data.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";
import type { ResearchImportRequest, ResearchImportPreview, TrainingMetricsPage } from "../domain/research.js";
import type { PairedComparison, PairedComparisonRequest } from "../domain/research.js";
import type { CounterexampleSet } from "../domain/research.js";
import type { RemoteTarget, RunEvidence } from "../domain/research.js";
import type { InspectionSession, ResearchArtifact, ArtifactContent } from "../domain/research.js";
import type { ResearchBundleExport, ResearchBundlePreview } from "../domain/research.js";

/** A list of records, and those that could not be read. */
interface RecordList<T> {
  items: T[];
  problems: { id: string; error: string }[];
}

/** The research workbench's records, files and runs, all kept in the project's own folder. */
export class ResearchService {
  constructor(private readonly runtime: RuntimeClient) {}

  private route(project: string): string {
    return `/projects/${encodeURIComponent(project)}/research`;
  }

  /** An exploration has its own evidence namespace instead of masquerading as a scored run. */
  private inspectionRoute(project: string, source: string): string {
    return source.startsWith("inspection_") ? `${this.route(project)}/inspection-sessions/${source}/actions` : `${this.route(project)}/runs/${source}/inspections`;
  }

  inspectionSessions(project: string): Promise<RecordList<InspectionSession>> {
    return this.runtime.request(`${this.route(project)}/inspection-sessions`);
  }

  createInspectionSession(project: string, modelIds: string[], title?: string): Promise<InspectionSession> {
    return this.send(`${this.route(project)}/inspection-sessions`, "POST", { modelIds, title });
  }

  artifacts(project: string): Promise<RecordList<ResearchArtifact>> {
    return this.runtime.request(`${this.route(project)}/artifacts`);
  }

  registerArtifact(project: string, request: { path?: string; uri?: string; kind: ResearchArtifact["kind"]; runId?: string; inspectionId?: string; metadata?: unknown }): Promise<ResearchArtifact> {
    return this.send(`${this.route(project)}/artifacts/register`, "POST", request);
  }

  importArtifactManifest(project: string, runId: string): Promise<{ items: ResearchArtifact[] }> {
    return this.send(`${this.route(project)}/artifacts/from-run`, "POST", { runId });
  }

  artifactContent(project: string, id: string): Promise<ArtifactContent> {
    return this.runtime.request(`${this.route(project)}/artifacts/${id}/content`);
  }

  /** Exports the project's research evidence and static reports, listing uncopied dependencies explicitly. */
  exportBundle(project: string, path?: string): Promise<ResearchBundleExport> {
    return this.send(`${this.route(project)}/bundles/export`, "POST", path ? { path } : {});
  }

  previewBundle(project: string, path: string): Promise<ResearchBundlePreview> {
    return this.send(`${this.route(project)}/bundles/preview`, "POST", { path });
  }

  importBundle(project: string, path: string, expectedSha256: string): Promise<{ imported: number; reused: number; activeRunsArchived: number; note: string }> {
    return this.send(`${this.route(project)}/bundles/import`, "POST", { path, expectedSha256 });
  }

  /** Reads old results without creating an experiment or changing their source. */
  previewImport(project: string, request: ResearchImportRequest): Promise<ResearchImportPreview> {
    return this.send(`${this.route(project)}/imports/preview`, "POST", request);
  }

  /** Creates new, non-executable records from the exact previewed source. */
  importResults(project: string, request: ResearchImportRequest): Promise<{ experiment: ExperimentDraft; version: FrozenVersion; run: ExperimentRun }> {
    return this.send(`${this.route(project)}/imports`, "POST", request);
  }

  /** Reads a page of training metrics using byte offsets. */
  metrics(project: string, run: string, cursor = 0): Promise<TrainingMetricsPage> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/metrics?cursor=${cursor}`);
  }

  /** Compares the same inputs and optionally keeps every regression as a counterexample set. */
  pairedComparison(project: string, request: PairedComparisonRequest): Promise<PairedComparison> {
    return this.send(`${this.route(project)}/comparisons`, "POST", request);
  }

  /** Lists saved regression cohorts, including their original requests and full memberships. */
  counterexampleSets(project: string): Promise<RecordList<CounterexampleSet>> {
    return this.runtime.request(`${this.route(project)}/counterexample_sets`);
  }

  /** SSH keeps credentials; Saturn saves only the configured host and working tree. */
  remoteTarget(project: string): Promise<{ target: RemoteTarget | null; note: string }> {
    return this.runtime.request(`${this.route(project)}/remote`);
  }

  setRemoteTarget(project: string, target: RemoteTarget): Promise<{ target: RemoteTarget; note: string }> {
    return this.send(`${this.route(project)}/remote`, "PUT", target);
  }

  checkRemoteTarget(project: string): Promise<{ protocol: number; platform: string; workdir: string }> {
    return this.send(`${this.route(project)}/remote/check`, "POST");
  }

  /** Finds this Saturn's worker on the SSH host; a ready one becomes the program runs use. */
  pairRemoteWorker(project: string): Promise<WorkerPairing> {
    return this.send(`${this.route(project)}/remote/pair`, "POST");
  }

  /** Installs this Saturn's worker on the SSH host, as the person asked, and pairs with it. */
  installRemoteWorker(project: string): Promise<WorkerPairing> {
    return this.send(`${this.route(project)}/remote/install`, "POST");
  }

  /** Records a launch intent; the remote worker persists independently of the desktop and runtime. */
  startRemote(project: string, request: { versionId: string; clientId: string; timeoutSeconds: number; resumeFrom?: string }): Promise<ExperimentRun> {
    return this.send(`${this.route(project)}/remote/runs`, "POST", request);
  }

  private send<T>(path: string, method: string, body?: unknown): Promise<T> {
    return this.runtime.request<T>(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  readSource(project: string, path: string): Promise<SourceView> {
    return this.runtime.request<SourceView>(`${this.route(project)}/source?path=${encodeURIComponent(path)}`);
  }

  /** Saves a file if it is still at `expectedRevision`; the runtime answers 409 if it is not. */
  writeSource(project: string, path: string, content: string, expectedRevision: string | null): Promise<{ revision: string }> {
    return this.send(`${this.route(project)}/source`, "PUT", { path, content, expectedRevision });
  }

  experiments(project: string): Promise<RecordList<ExperimentDraft>> {
    return this.runtime.request(`${this.route(project)}/experiments`);
  }

  createExperiment(project: string, fields: Pick<ExperimentDraft, "title" | "command" | "inputs">): Promise<ExperimentDraft> {
    return this.send(`${this.route(project)}/experiments`, "POST", fields);
  }

  updateExperiment(project: string, draft: ExperimentDraft, fields: Partial<ExperimentDraft>): Promise<ExperimentDraft> {
    return this.send(`${this.route(project)}/experiments/${draft.id}`, "PATCH", { ...fields, expectedRevision: draft.revision });
  }

  /** Moves an experiment, its versions and runs to the records' trash, if it is still at the revision shown. */
  deleteExperiment(project: string, draft: ExperimentDraft): Promise<{ deleted: string; versions: string[]; runs: string[]; trash: string }> {
    return this.send(`${this.route(project)}/experiments/${draft.id}?expectedRevision=${draft.revision}`, "DELETE");
  }

  freeze(project: string, experiment: string): Promise<FrozenVersion> {
    return this.send(`${this.route(project)}/experiments/${experiment}/versions`, "POST");
  }

  startRun(project: string, version: string, clientId: string): Promise<ExperimentRun> {
    return this.send(`${this.route(project)}/versions/${version}/runs`, "POST", { clientId });
  }

  stopRun(project: string, run: string): Promise<ExperimentRun> {
    return this.send(`${this.route(project)}/runs/${run}/stop`, "POST");
  }

  /** Holds a running run where it is; it keeps its memory and devices until it is continued or stopped. */
  pauseRun(project: string, run: string): Promise<ExperimentRun> {
    return this.send(`${this.route(project)}/runs/${run}/pause`, "POST");
  }

  /** Lets a paused run go on. */
  continueRun(project: string, run: string): Promise<ExperimentRun> {
    return this.send(`${this.route(project)}/runs/${run}/continue`, "POST");
  }

  /** Starts a new run of the same version that takes over from one that stopped, was interrupted or failed. */
  resumeRun(project: string, run: string, clientId: string): Promise<ExperimentRun> {
    return this.send(`${this.route(project)}/runs/${run}/resume`, "POST", { clientId });
  }

  runs(project: string): Promise<RecordList<ExperimentRun>> {
    return this.runtime.request(`${this.route(project)}/runs`);
  }

  samples(project: string, run: string, cursor = 0, only: "all" | "disputed" | "errors" = "all", limit?: number): Promise<{ items: SampleItem[]; next: number | null }> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/samples?cursor=${cursor}&only=${only}${limit ? `&limit=${limit}` : ""}`);
  }

  evidence(project: string, run: string): Promise<RunEvidence> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/evidence`);
  }

  log(project: string, run: string, stream: "stdout" | "stderr"): Promise<{ text: string }> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/log?stream=${stream}`);
  }

  findings(project: string): Promise<RecordList<Finding>> {
    return this.runtime.request(`${this.route(project)}/findings`);
  }

  addFinding(project: string, text: string, kind: FindingKind, runIds: string[], inspectionIds?: string[]): Promise<Finding> {
    return this.send(`${this.route(project)}/findings`, "POST", { text, kind, runIds, ...(inspectionIds ? { inspectionIds } : {}) });
  }

  questions(project: string): Promise<RecordList<Question>> {
    return this.runtime.request(`${this.route(project)}/questions`);
  }

  addQuestion(project: string, title: string): Promise<Question> {
    return this.send(`${this.route(project)}/questions`, "POST", { title });
  }

  hypotheses(project: string): Promise<RecordList<Hypothesis>> {
    return this.runtime.request(`${this.route(project)}/hypotheses`);
  }

  addHypothesis(project: string, title: string, questionId?: string): Promise<Hypothesis> {
    return this.send(`${this.route(project)}/hypotheses`, "POST", { title, questionId });
  }

  setVerdict(project: string, hypothesis: Hypothesis, verdict: Hypothesis["verdict"]): Promise<Hypothesis> {
    return this.send(`${this.route(project)}/hypotheses/${hypothesis.id}`, "PATCH", { verdict, expectedRevision: hypothesis.revision });
  }

  models(project: string): Promise<RecordList<ModelNode>> {
    return this.runtime.request(`${this.route(project)}/models`);
  }

  addModel(project: string, fields: Pick<ModelNode, "source" | "name" | "weightsRevision" | "parentId" | "trainingData" | "referenceId" | "producedBy">): Promise<ModelNode> {
    return this.send(`${this.route(project)}/models`, "POST", fields);
  }

  updateModel(project: string, model: ModelNode, fields: Partial<Pick<ModelNode, "note" | "referenceId" | "producedBy" | "trainingData">>): Promise<ModelNode> {
    return this.send(`${this.route(project)}/models/${model.id}`, "PATCH", { ...fields, expectedRevision: model.revision });
  }

  versions(project: string): Promise<RecordList<FrozenVersion>> {
    return this.runtime.request(`${this.route(project)}/versions`);
  }

  compare(project: string, left: string, right: string): Promise<Comparison> {
    return this.runtime.request(`${this.route(project)}/compare?left=${left}&right=${right}`);
  }

  sampleAcross(project: string, sample: string, runs: string[]): Promise<{ rows: AcrossRow[] }> {
    return this.runtime.request(`${this.route(project)}/samples/${encodeURIComponent(sample)}?runs=${runs.join(",")}`);
  }

  summary(project: string, run: string): Promise<RunSummary> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/summary`);
  }

  labels(project: string, run: string): Promise<RunLabels> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/labels`);
  }

  /** How the run's raters agree with each other, the adjudicated labels and the scorer. */
  labelAgreement(project: string, run: string): Promise<LabelAgreement> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/labels/agreement`);
  }

  setLabel(project: string, run: string, sample: { sampleId: string; trial?: number; modelId?: string | null }, label: string): Promise<unknown> {
    return this.send(`${this.route(project)}/runs/${run}/labels`, "POST", { ...sample, label });
  }

  addCounterexample(project: string, run: string, sampleId: string, note: string): Promise<unknown> {
    return this.send(`${this.route(project)}/counterexamples`, "POST", { runId: run, sampleId, note });
  }

  policy(project: string): Promise<ResearchPolicy> {
    return this.runtime.request(`${this.route(project)}/policy`);
  }

  /** Lets an agent change a locked file until the next version is frozen, which locks it again. */
  releaseLock(project: string, policy: ResearchPolicy, path: string): Promise<ResearchPolicy> {
    return this.send(`${this.route(project)}/policy`, "PUT", {
      expectedRevision: policy.revision,
      locked: policy.locked,
      released: [...new Set([...(policy.released ?? []), path])],
    });
  }

  events(project: string): Promise<{ items: ResearchEvent[] }> {
    return this.runtime.request(`${this.route(project)}/events`);
  }

  /** A model's activations on a sample, read in the project's own Python and saved with the run; the same request again is answered from what was saved. */
  activations(project: string, run: string, sampleId: string, modelId: string | null): Promise<ActivationView> {
    return this.send(`${this.route(project)}/runs/${run}/activations`, "POST", { sampleId, modelId });
  }

  /** Every layer patched from one model into another on several samples, in one helper process; saved with the run. */
  sweep(project: string, request: { runId: string; sampleIds: string[]; sourceModelId: string; targetModelId: string; layers?: number[] }): Promise<SweepView> {
    return this.send(`${this.route(project)}/interventions/sweep`, "POST", request);
  }

  /** Two models read on a prompt of your own, with a run's Python and weights; saved with the run. */
  compareModels(project: string, run: string, request: { modelId: string; otherModelId: string; input: string; expected?: string }): Promise<ModelCompareView> {
    return this.send(this.inspectionRoute(project, run), "POST", { action: "compare", ...request });
  }

  /** A clean prompt patched into a corrupted one at every layer and position, beside a random control; saved with the run. */
  patchPrompts(project: string, run: string, request: { modelId: string; clean: string; corrupted: string; expected: string; alternative: string }): Promise<PromptPatchView> {
    return this.send(this.inspectionRoute(project, run), "POST", { action: "prompts", ...request });
  }

  /** One layer on a prompt of your own read through a sparse autoencoder, with one feature set to zero if asked; saved with the run. */
  readFeatures(project: string, run: string, request: { modelId: string; prompt: string; layer: number; saeRelease?: string; saeId?: string; saePath?: string; expected?: string; alternative?: string; ablate?: number }): Promise<FeaturesView> {
    return this.send(this.inspectionRoute(project, run), "POST", { action: "features", ...request });
  }

  /** Every file named as a data input, with who used it. Slow only while a changed file is hashed. */
  dataList(project: string): Promise<DataList> {
    return this.runtime.request(`${this.route(project)}/data`);
  }

  /** A page of a data file's rows, from where the last page ended. */
  dataPreview(project: string, path: string, cursor: number, split?: string): Promise<DataPage> {
    const query = new URLSearchParams({ path, cursor: String(cursor), ...(split ? { split } : {}) });
    return this.runtime.request(`${this.route(project)}/data/preview?${query}`);
  }

  /** What a data file's columns hold. The runtime reads the whole file the first time. */
  dataProfile(project: string, path: string, split?: string): Promise<DataProfile> {
    const query = new URLSearchParams({ path, ...(split ? { split } : {}) });
    return this.runtime.request(`${this.route(project)}/data/profile?${query}`);
  }

  /** How many rows two data files share, whole or by chosen columns. Exact duplicates only. */
  dataOverlap(project: string, left: string, right: string, columns: string[]): Promise<DataOverlap> {
    const query = new URLSearchParams({ left, right, ...(columns.length ? { columns: columns.join(",") } : {}) });
    return this.runtime.request(`${this.route(project)}/data/overlap?${query}`);
  }

  /** What was saved under a run's inside folder: readings and sweeps, newest first. */
  insideList(project: string, run: string): Promise<{ runId: string; items: InsideItem[] }> {
    return this.runtime.request((run.startsWith("inspection_") ? `${this.route(project)}/inspection-sessions/${run}/inside` : `${this.route(project)}/runs/${run}/inside`));
  }

  /** Every sample line of a run, page by page, up to a limit. */
  async allSamples(project: string, run: string, limit = 5000): Promise<SampleLine[]> {
    const lines: SampleLine[] = [];
    let cursor: number | null = 0;
    while (cursor !== null && lines.length < limit) {
      const page: { items: SampleItem[]; next: number | null } = await this.samples(project, run, cursor);
      for (const item of page.items) if (item.sample) lines.push(item.sample);
      cursor = page.next;
    }
    return lines;
  }

  /** One layer patched from one model into another on a sample, in the same way. */
  intervene(project: string, request: InterventionRequest): Promise<ActivationView> {
    return this.send(`${this.route(project)}/interventions`, "POST", request);
  }

  /** What a run's processes cost, sampled while it lives. */
  resources(project: string, run: string): Promise<RunResources> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/resources`);
  }

  environment(project: string): Promise<EnvironmentRecord> {
    return this.runtime.request(`${this.route(project)}/environment`);
  }

  /** Sets the project's Python; an empty path forgets it. */
  setEnvironment(project: string, python: string): Promise<EnvironmentRecord> {
    return this.send(`${this.route(project)}/environment`, "PUT", { python });
  }

  /** Asks the project's Python what it is and has. */
  checkEnvironment(project: string): Promise<EnvironmentRecord> {
    return this.send(`${this.route(project)}/environment/check`, "POST");
  }

  /** Makes the managed environment in the project, with the bundled kit unless declined. A job; the record says how it goes. */
  createEnvironment(project: string, options: { python?: string; withCore: boolean; timeoutSeconds?: number }): Promise<EnvironmentRecord> {
    return this.send(`${this.route(project)}/environment/create`, "POST", options);
  }

  /** Installs a kit, named packages, or what the lock file says, into the managed environment. */
  installPackages(project: string, request: { kit?: string; packages?: string[]; sync?: boolean; timeoutSeconds?: number }): Promise<EnvironmentRecord> {
    return this.send(`${this.route(project)}/environment/install`, "POST", request);
  }

  stopEnvironmentJob(project: string): Promise<unknown> {
    return this.send(`${this.route(project)}/environment/job/stop`, "POST");
  }

  /** Writes a file into the project, for taking an experiment's record elsewhere. */
  async exportFile(project: string, path: string, content: string): Promise<void> {
    await this.writeSource(project, path, content, null);
  }

  /** Asks a screen to open on something: the Samples screen reads it when it shows, the workspace follows it at once. An
   * experiment is the one both Experiments and the workspace's experiment bar are on. */
  open(project: string, target: OpenTarget): void {
    const session = this.loadSession(project);
    if (target.kind === "sample") this.saveSession(project, { ...session, review: target });
    else if (target.kind === "experiment") this.saveSession(project, { ...session, experimentId: target.experimentId });
    else this.saveSession(project, { ...session, file: target.path });
    window.dispatchEvent(new CustomEvent<OpenTarget>("saturn-research-open", { detail: target }));
  }

  /** Hears what `open` asks for. */
  onOpen(listener: (target: OpenTarget) => void): () => void {
    const handle = (event: Event) => listener((event as CustomEvent<OpenTarget>).detail);
    window.addEventListener("saturn-research-open", handle);
    return () => window.removeEventListener("saturn-research-open", handle);
  }

  /** The moment this device last opened the project, and marks now as the newest visit. */
  visit(project: string): string | null {
    const session = this.loadSession(project);
    this.saveSession(project, { ...session, visitedAt: new Date().toISOString() });
    return session.visitedAt ?? null;
  }

  /** What this project's workbench had open. It is a convenience, so losing it loses no research. */
  loadSession(project: string): ResearchSession {
    try {
      return JSON.parse(localStorage.getItem(`saturn-research-${project}`) ?? "{}") as ResearchSession;
    } catch {
      return {};
    }
  }

  saveSession(project: string, session: ResearchSession): void {
    try {
      localStorage.setItem(`saturn-research-${project}`, JSON.stringify(session));
    } catch {
      // A full or blocked store only loses where the workbench reopens.
    }
  }
}
