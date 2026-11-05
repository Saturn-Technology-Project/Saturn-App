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
  evaluation?: EvaluationSpec;
  models?: ModelBinding[];
  /** The question and hypothesis this experiment is for, when the person said. */
  questionId?: string;
  hypothesisId?: string;
  /** The words a person labels this experiment's samples with; the default set when not said. */
  labels?: string[];
}

/** The labels a person can put on a sample: the experiment's own, or the plain set. */
export const DEFAULT_LABELS = ["Correct", "Wrong", "Invalid", "Unsure"];
export function labelsOf(draft: ExperimentDraft | null | undefined): string[] {
  const own = (draft?.labels ?? []).map((item) => item.trim()).filter(Boolean);
  return own.length ? own : DEFAULT_LABELS;
}

/** A model an experiment measures, and what it stands for in it. */
export interface ModelBinding {
  modelId: string;
  role: ModelRole;
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
  evaluation?: EvaluationSpec | null;
  models?: { modelId: string; role: ModelRole; source: string; weightsRevision: string | null; floating: boolean }[];
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
  /** The most samples any one model got. */
  samplesPerModel?: number;
  /** What the runtime noticed at the end: a sample count unlike the last comparable run's, for one. */
  warnings?: string[];
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
  /** What the scorer compared the output with, when the program wrote it down. */
  expected?: unknown;
  scores?: Record<string, number | string | boolean> | null;
  /** The scorer's own word for its result, when the program wrote one. */
  scorerLabel?: string;
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
  /** The frozen model a preference-trained one was trained against. */
  referenceId?: string;
  /** How these weights came about: a training run, a script, a published release. */
  producedBy?: string;
  /** The person's own note on this node. */
  note?: string;
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
  /** Locks the user lifted until the next frozen version. */
  released?: string[];
}

/** The file a refusal was about, when it was a lock. */
export function lockedPathOf(event: ResearchEvent): string | null {
  return event.kind === "refused" && /is locked for this experiment/.test(event.reason) ? event.path : null;
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

/** The evaluation fields two versions share: stated in the spec, and neither different nor missing. */
export function heldFixed(spec: EvaluationSpec | null | undefined, comparison: Comparison): { field: string; value: string }[] {
  const apart = new Set([...comparison.differs, ...comparison.missing]);
  return EVALUATION_FIELD_NAMES.flatMap((field) => {
    const value = spec?.[field];
    const stated = value !== undefined && value !== "" && !(field === "chatTemplate" && value === null);
    return stated && !apart.has(field) ? [{ field, value: typeof value === "string" ? value : JSON.stringify(value) }] : [];
  });
}

/** The evaluation fields, in the order they are shown. */
export const EVALUATION_FIELD_NAMES = ["dataset", "split", "sampleSet", "scorer", "promptFormat", "chatTemplate"] as const satisfies readonly (keyof EvaluationSpec)[];

/** Each factor of a comparison with whether it held, for saying what differs and what did not. */
export function comparisonFactors(spec: EvaluationSpec | null | undefined, comparison: Comparison | null): { field: string; state: "same" | "differs" | "missing"; value: string | null }[] {
  return EVALUATION_FIELD_NAMES.map((field) => {
    const value = spec?.[field];
    const shown = value === undefined || value === null || value === "" ? null : typeof value === "string" ? value : JSON.stringify(value);
    const state = comparison?.differs.includes(field) ? "differs" : comparison?.missing.includes(field) || shown === null ? "missing" : "same";
    return { field, state, value: shown };
  });
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
  /** Tokens the program reported, added up, and how many samples reported any. */
  tokens?: { input: number; output: number; samplesReporting: number };
  deviceMemoryPeakBytes?: number | null;
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

/** Where a run's score comes from: what the scorer judged, what a person disputed, and what was kept out. */
export interface ScoreSources {
  /** Samples the scorer gave a score. */
  scored: number;
  /** Samples a person labeled. */
  reviewed: number;
  /** Labeled samples where the person and the scorer disagree. */
  disputed: number;
  /** Samples excluded for an infrastructure error. */
  infrastructure: number;
  /** Samples with a model or scorer error. */
  otherErrors: number;
}

export function scoreSources(summary: RunSummary, labels: RunLabels | null): ScoreSources {
  let infrastructure = 0;
  let otherErrors = 0;
  let samples = 0;
  for (const model of summary.models) {
    samples += model.samples;
    for (const [kind, count] of Object.entries(model.errors)) {
      if (kind === "infrastructure") infrastructure += count;
      else otherErrors += count;
    }
  }
  const agreement = labels?.agreement;
  return {
    scored: samples - infrastructure - otherErrors,
    reviewed: agreement?.labeled ?? 0,
    disputed: agreement ? agreement.compared - agreement.agreed : 0,
    infrastructure,
    otherErrors,
  };
}

/** How far a run's review is: labeled samples against those with a score. */
export function reviewProgress(summary: RunSummary | null, labels: RunLabels | null): { labeled: number; total: number } {
  const sources = summary ? scoreSources(summary, labels) : null;
  return { labeled: labels?.agreement.labeled ?? 0, total: sources?.scored ?? 0 };
}

/** The newest change among records, for saying when the work stopped. */
export function lastActive(groups: { updatedAt: string }[][]): string | null {
  let newest: string | null = null;
  for (const group of groups) for (const item of group) if (!newest || item.updatedAt > newest) newest = item.updatedAt;
  return newest;
}

/** Records changed after a moment, newest first. */
export function changedSince<T extends { updatedAt: string }>(items: T[], since: string | null): T[] {
  return [...items].filter((item) => !since || item.updatedAt > since).sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
}

/** Activations a run captured for one sample at one model, as the runtime will serve them. Each layer holds one value per token. */
export interface ActivationView {
  sampleId: string;
  modelId: string | null;
  /** What each value is: a norm, a projection onto a direction, a logit lens score. */
  measure: string;
  tokens: string[];
  layers: { layer: number; values: number[] }[];
  /** The model's top token at the end, as text. */
  top?: string;
  /** The same reading after one layer was patched in from another model. */
  patched?: { layer: number; sourceModelId: string | null; layers: { layer: number; values: number[] }[]; top: string } | null;
  recordedAt?: string;
}

/** Every layer patched from one model into another, on several samples: what the target then ends on at each. */
export interface SweepView {
  sourceModelId: string | null;
  targetModelId: string | null;
  layers: number[];
  samples: { sampleId: string; expected: string | null; top: string; expectedLogProb: number | null; byLayer: { layer: number; top: string; expectedLogProb: number | null }[] }[];
  recordedAt?: string;
}

/** One thing saved under a run's inside folder: a reading of one sample, or a sweep. */
export type InsideItem = ({ kind: "reading" } & ActivationView) | ({ kind: "sweep" } & SweepView);

/** The sweeps into a model, with every tied best layer; zero recoveries do not identify a best layer. */
export function mechanismOf(items: InsideItem[], modelId: string): { sourceModelId: string | null; layers: number[]; restored: number; of: number; recordedAt?: string }[] {
  return items.flatMap((item) => {
    if (item.kind !== "sweep" || item.targetModelId !== modelId || !item.layers.length) return [];
    const totals = restoredByLayer(item);
    const restored = Math.max(...totals);
    const layers = restored > 0 ? item.layers.filter((_, index) => totals[index] === restored) : [];
    return [{ sourceModelId: item.sourceModelId, layers, restored, of: item.samples.length, recordedAt: item.recordedAt }];
  });
}

/** Whether the patched model ends on the expected token: what "restored" means here, said once. */
export function restores(sample: SweepView["samples"][number], layer: number): boolean {
  const at = sample.byLayer.find((item) => item.layer === layer);
  return Boolean(sample.expected && at && at.top === sample.expected);
}

/** How many samples each layer restores, in the sweep's layer order. */
export function restoredByLayer(view: SweepView): number[] {
  return view.layers.map((layer) => view.samples.filter((sample) => restores(sample, layer)).length);
}

/** Whether a sample line is one the scorer marked wrong: a false score, or a scorer word that says so. */
export function scorerSaysWrong(line: SampleLine): boolean {
  if (line.error) return false;
  if (line.scorerLabel && /wrong|incorrect|fail/i.test(line.scorerLabel)) return true;
  return Object.values(line.scores ?? {}).some((score) => score === false);
}

/** An intervention the runtime will carry out: weights of one layer patched from a source model into a target, on one sample. */
export interface InterventionRequest {
  runId: string;
  sampleId: string;
  sourceModelId: string;
  targetModelId: string;
  layer: number;
}

/** One reading of what a run's processes cost, as the runtime sampled it. */
export interface ResourcePoint {
  at: string;
  elapsedMs: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
  processes: number | null;
  samplesBytes: number;
  samplesLines: number;
  /** Tokens the program reported under each sample's `usage`, added up so far. */
  inputTokens: number;
  outputTokens: number;
  /** The device memory the program last said it held, or null when it never said. */
  deviceMemoryBytes: number | null;
  gpus: { name: string; utilizationPercent: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null }[] | null;
}

export interface RunResources {
  runId: string;
  status: RunStatus;
  system: { cpus: number; platform: string };
  points: ResourcePoint[];
}

/** How fast a count grew per second over the newest readings. Null until two readings differ in time. */
export function throughput(points: ResourcePoint[], window = 10, of: (point: ResourcePoint) => number = (point) => point.samplesLines): number | null {
  const recent = points.slice(-window);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || last.elapsedMs <= first.elapsedMs) return null;
  return ((of(last) - of(first)) * 1000) / (last.elapsedMs - first.elapsedMs);
}

/** Bytes in the unit that reads best. */
export function bytesText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** A length of time in words, for how long a run has been going. */
export function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The Python a project's experiments run in, as the runtime keeps it. */
export interface EnvironmentRecord {
  revision: number;
  python: string | null;
  suggestedPython?: string | null;
  checkedAt?: string;
  checkedWith?: string;
  report: EnvironmentReport | null;
  lockFiles: { path: string; sha256: string; size: number }[];
  /** What this computer can make environments with, and whether the project's managed one exists. */
  tools: { uv: string | null; python3: string | null; managed: { path: string; python: string; exists: boolean } };
  kits: EnvironmentKit[];
  job: EnvironmentJob | null;
}

/** A set of packages for one kind of work; `bundled` goes in with the environment unless declined. */
export interface EnvironmentKit {
  id: string;
  title: string;
  what: string;
  bundled: boolean;
  packages: { name: string; installed: string | null }[];
}

/** One change to the managed environment: what ran, and how it went. */
export interface EnvironmentJob {
  id: string;
  kind: "create" | "install" | "sync";
  commands: string[];
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  logTail: string;
  logLines: number;
}

/** How a kit stands: all of it installed, some, or none, by the last check of the managed interpreter. */
export function kitState(kit: EnvironmentKit): "installed" | "partly" | "missing" {
  const have = kit.packages.filter((item) => item.installed).length;
  return have === kit.packages.length ? "installed" : have ? "partly" : "missing";
}

export interface EnvironmentReport {
  executable: string;
  version: string;
  platform: string;
  cpus: number | null;
  packages: Record<string, string | null>;
  devices: { torch: string | null; reason?: string; cuda?: boolean; cudaDevices?: string[]; mps?: boolean };
}

/** The compute an environment can offer, in words. */
export function devicesText(report: EnvironmentReport | null): string {
  if (!report) return "Not checked yet";
  const devices = report.devices;
  if (!devices.torch) return devices.reason ?? "torch is not installed";
  if (devices.cuda) return `CUDA: ${(devices.cudaDevices ?? []).join(", ") || "available"}`;
  if (devices.mps) return "Apple MPS";
  return "CPU only";
}

/** Where a screen was asked to open: a sample in a run, or a file. */
export type OpenTarget = { kind: "sample"; runId: string; sampleId?: string; only?: "disputed" | "errors" | "all" } | { kind: "file"; path: string };

/** What a project's workbench reopens to. */
export interface ResearchSession {
  file?: string;
  experimentId?: string;
  runId?: string;
  /** A draft not saved yet, with the revision it was based on. */
  draft?: { file: string; content: string; revision: string | null };
  /** When this device last opened the project, for saying what changed since. */
  visitedAt?: string;
  /** What another screen asked the Samples screen to show. */
  review?: Extract<OpenTarget, { kind: "sample" }>;
}
