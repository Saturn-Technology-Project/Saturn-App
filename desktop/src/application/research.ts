import type {
  AcrossRow,
  ActivationView,
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
  ParticipationMode,
  Question,
  ResearchEvent,
  ResearchPolicy,
  RunLabels,
  RunResources,
  RunSummary,
  ResearchSession,
  SampleItem,
  SampleLine,
  SourceView,
  SweepView,
} from "../domain/research.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

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

  freeze(project: string, experiment: string): Promise<FrozenVersion> {
    return this.send(`${this.route(project)}/experiments/${experiment}/versions`, "POST");
  }

  startRun(project: string, version: string, clientId: string): Promise<ExperimentRun> {
    return this.send(`${this.route(project)}/versions/${version}/runs`, "POST", { clientId });
  }

  stopRun(project: string, run: string): Promise<ExperimentRun> {
    return this.send(`${this.route(project)}/runs/${run}/stop`, "POST");
  }

  runs(project: string): Promise<RecordList<ExperimentRun>> {
    return this.runtime.request(`${this.route(project)}/runs`);
  }

  samples(project: string, run: string, cursor = 0, only: "all" | "disputed" | "errors" = "all"): Promise<{ items: SampleItem[]; next: number | null }> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/samples?cursor=${cursor}&only=${only}`);
  }

  log(project: string, run: string, stream: "stdout" | "stderr"): Promise<{ text: string }> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/log?stream=${stream}`);
  }

  findings(project: string): Promise<RecordList<Finding>> {
    return this.runtime.request(`${this.route(project)}/findings`);
  }

  addFinding(project: string, text: string, kind: FindingKind, runIds: string[]): Promise<Finding> {
    return this.send(`${this.route(project)}/findings`, "POST", { text, kind, runIds });
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

  setLabel(project: string, run: string, sample: { sampleId: string; trial?: number; modelId?: string | null }, label: string): Promise<unknown> {
    return this.send(`${this.route(project)}/runs/${run}/labels`, "POST", { ...sample, label });
  }

  addCounterexample(project: string, run: string, sampleId: string, note: string): Promise<unknown> {
    return this.send(`${this.route(project)}/counterexamples`, "POST", { runId: run, sampleId, note });
  }

  policy(project: string): Promise<ResearchPolicy> {
    return this.runtime.request(`${this.route(project)}/policy`);
  }

  setMode(project: string, policy: ResearchPolicy, path: string, mode: ParticipationMode): Promise<ResearchPolicy> {
    return this.send(`${this.route(project)}/policy`, "PUT", {
      expectedRevision: policy.revision,
      modes: { ...policy.modes, [path]: mode },
      locked: policy.locked,
      released: policy.released ?? [],
    });
  }

  /** Lets an agent change a locked file until the next version is frozen, which locks it again. */
  releaseLock(project: string, policy: ResearchPolicy, path: string): Promise<ResearchPolicy> {
    return this.send(`${this.route(project)}/policy`, "PUT", {
      expectedRevision: policy.revision,
      modes: policy.modes,
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

  /** What was saved under a run's inside folder: readings and sweeps, newest first. */
  insideList(project: string, run: string): Promise<{ runId: string; items: InsideItem[] }> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/inside`);
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

  /** Asks a screen to open on something: the Samples screen reads it when it shows, the workspace follows it at once. */
  open(project: string, target: OpenTarget): void {
    const session = this.loadSession(project);
    if (target.kind === "sample") this.saveSession(project, { ...session, review: target });
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
