import type {
  ExperimentDraft,
  ExperimentRun,
  Finding,
  FindingKind,
  FrozenVersion,
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
