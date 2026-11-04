/** A research record as the runtime saves it. */
export interface ResearchRecord {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** An experiment's draft. It keeps changing; running it freezes a version. */
export interface ExperimentDraft extends ResearchRecord {
  title: string;
  command?: string;
  inputs?: { code?: string[]; data?: string[]; scorer?: string[]; environment?: string[] };
}

export type FindingKind = "observation" | "ai_suggestion" | "conclusion";

export interface Finding extends ResearchRecord {
  text: string;
  kind: FindingKind;
  runIds?: string[];
}

export interface FrozenVersion extends ResearchRecord {
  experimentId: string;
  number: number;
}

export type RunStatus = "starting" | "running" | "stopping" | "stopped" | "completed" | "failed" | "interrupted" | "protocol_error";

export interface ExperimentRun extends ResearchRecord {
  versionId: string;
  experimentId: string;
  status: RunStatus;
  samples?: number;
  infrastructureErrors?: number;
  exitCode?: number | null;
  error?: string;
  process?: string;
  problems?: { line: number; reason: string }[];
  inputsChanged?: string[];
}

export interface SourceEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export type SourceView =
  | { kind: "directory"; path: string; entries: SourceEntry[] }
  | { kind: "file"; path: string; content: string; revision: string };

export interface SampleLine {
  sampleId: string;
  trial?: number;
  modelId?: string | null;
  input?: unknown;
  output?: unknown;
  scores?: Record<string, number | string | boolean> | null;
  error?: { kind: string; message?: string } | null;
}

/** One line of a samples file: a sample, or what is wrong with it. */
export interface SampleItem {
  offset: number;
  sample?: SampleLine;
  problem?: string;
  raw?: string;
}

export type Verdict = "undecided" | "supported" | "refuted" | "inconclusive";

export interface Question extends ResearchRecord {
  title: string;
}

/** A hypothesis. Only its `verdict` says whether it holds; a run's status does not. */
export interface Hypothesis extends ResearchRecord {
  title: string;
  verdict: Verdict;
  questionId?: string;
}

/** A set of weights. `floating` means no revision pins it. */
export interface ModelNode extends ResearchRecord {
  source: string;
  weightsRevision?: string;
  floating: boolean;
  parentId?: string;
  name?: string;
  trainingData?: string;
}

/** How an experiment measures: what two runs must share to be compared. */
export interface EvaluationSpec {
  dataset?: string;
  split?: string;
  sampleSet?: string;
  scorer?: string;
  promptFormat?: string;
  chatTemplate?: string | null;
  generation?: unknown;
}

export type ModelRole = "base" | "reference" | "policy";

export interface Comparison {
  result: "comparable" | "not_comparable" | "unknown";
  differs: string[];
  missing: string[];
}

export interface AcrossRow {
  runId: string;
  versionId: string;
  status: RunStatus;
  models?: { modelId: string; role: string; source: string; weightsRevision: string | null; floating: boolean }[];
  comparison: Comparison;
  samples: SampleLine[];
}

export interface RunLabels {
  labels: Record<string, { sampleId: string; trial: number; modelId?: string | null; label: string; note?: string }>;
  agreement: { labeled: number; compared: number; agreed: number };
}

export type ParticipationMode = "manual" | "pair" | "delegate";

export interface ResearchPolicy {
  revision: number;
  modes: Record<string, ParticipationMode>;
  locked: string[];
}

export type ResearchEvent =
  | { kind: "refused"; path: string; tool: string; reason: string; runId: string; at: string }
  | { kind: "integrity_changed"; paths: string[]; afterTool: string; runId: string; at: string }
  | { kind: "assisted"; path: string; tool: string; policyRevision: number; runId: string; at: string };

/** The mode that applies to a file: the most specific key wins, and a file with none is the agent's to change. */
export function modeOf(policy: ResearchPolicy, path: string): ParticipationMode {
  let chosen: ParticipationMode = "delegate";
  let length = -1;
  for (const [key, mode] of Object.entries(policy.modes)) {
    const folder = key.replace(/\/+$/, "");
    if ((path === folder || path.startsWith(`${folder}/`)) && folder.length > length) {
      chosen = mode;
      length = folder.length;
    }
  }
  return chosen;
}

/** Why two runs cannot be compared, in words. */
export function comparisonText(comparison: Comparison): string {
  if (comparison.result === "comparable") return "Measured the same way";
  if (comparison.result === "not_comparable") return `Not comparable, these differ: ${comparison.differs.join(", ")}`;
  return `Cannot tell: ${comparison.missing.join(", ")} not stated`;
}

/** Models as a forest: each with its depth, parents before their children. */
export function lineageOrder(models: ModelNode[]): { model: ModelNode; depth: number }[] {
  const known = new Set(models.map((model) => model.id));
  const children = new Map<string, ModelNode[]>();
  const roots: ModelNode[] = [];
  for (const model of models) {
    if (model.parentId && known.has(model.parentId)) {
      children.set(model.parentId, [...(children.get(model.parentId) ?? []), model]);
    } else {
      roots.push(model);
    }
  }
  const ordered: { model: ModelNode; depth: number }[] = [];
  const visit = (model: ModelNode, depth: number) => {
    ordered.push({ model, depth });
    for (const child of children.get(model.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return ordered;
}

/** One model's samples in a run, added up. */
export interface ModelSummary {
  modelId: string | null;
  samples: number;
  errors: Record<string, number>;
  scores: Record<string, { mean: number | null; count: number; notNumbers: number }>;
}

export interface RunSummary {
  runId: string;
  versionId: string;
  status: RunStatus;
  models: ModelSummary[];
}

/** A line of models: each continues its parent's line, and any other child starts a new one. */
export interface LineageTrack {
  from: ModelNode | null;
  nodes: ModelNode[];
}

/** Lays models out as lines, so checkpoints read as a line and a branch as a line of its own. */
export function lineageTracks(models: ModelNode[]): LineageTrack[] {
  const known = new Map(models.map((model) => [model.id, model]));
  const children = new Map<string, ModelNode[]>();
  for (const model of models) {
    if (model.parentId && known.has(model.parentId)) children.set(model.parentId, [...(children.get(model.parentId) ?? []), model]);
  }
  const tracks: LineageTrack[] = [];
  const follow = (start: ModelNode, from: ModelNode | null) => {
    const track: LineageTrack = { from, nodes: [] };
    tracks.push(track);
    let current: ModelNode | undefined = start;
    const branches: [ModelNode, ModelNode][] = [];
    while (current) {
      track.nodes.push(current);
      const [next, ...others]: ModelNode[] = children.get(current.id) ?? [];
      for (const other of others) branches.push([other, current]);
      current = next;
    }
    for (const [branch, parent] of branches) follow(branch, parent);
  };
  for (const model of models) if (!model.parentId || !known.has(model.parentId)) follow(model, null);
  return tracks;
}

/** Whether a run has samples worth adding up. */
export function runHasResults(status: RunStatus): boolean {
  return status === "completed" || status === "stopped" || status === "interrupted" || status === "protocol_error";
}

/** A score for showing: enough digits to tell runs apart. */
export function scoreText(value: number | null | undefined): string {
  return value === null || value === undefined ? "No score" : Number(value.toFixed(3)).toString();
}

/** Whether a run can still change. */
export function isRunActive(status: RunStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

/** A run's status in words. Execution says nothing about whether a hypothesis holds. */
export function runStatusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    starting: "Starting",
    running: "Running",
    stopping: "Stopping",
    stopped: "Stopped",
    completed: "Execution completed",
    failed: "Execution failed",
    interrupted: "Interrupted, samples kept",
    protocol_error: "Output has problems",
  };
  return labels[status];
}

/** A sample field as plain text: model output is only ever shown, never interpreted. */
export function sampleText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** What a project's workbench reopens to. */
export interface ResearchSession {
  file?: string;
  experimentId?: string;
  runId?: string;
  /** A draft not saved yet, with the revision it was based on. */
  draft?: { file: string; content: string; revision: string | null };
}
