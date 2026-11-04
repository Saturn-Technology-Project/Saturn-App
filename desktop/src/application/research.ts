import type {
  AcrossRow,
  Comparison,
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
  RunSummary,
  ResearchSession,
  SampleItem,
  SourceView,
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

  samples(project: string, run: string, cursor = 0): Promise<{ items: SampleItem[]; next: number | null }> {
    return this.runtime.request(`${this.route(project)}/runs/${run}/samples?cursor=${cursor}`);
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

  addModel(project: string, fields: Pick<ModelNode, "source" | "name" | "weightsRevision" | "parentId" | "trainingData">): Promise<ModelNode> {
    return this.send(`${this.route(project)}/models`, "POST", fields);
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
    });
  }

  events(project: string): Promise<{ items: ResearchEvent[] }> {
    return this.runtime.request(`${this.route(project)}/events`);
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
