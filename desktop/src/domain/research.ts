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
  /** Explicit wording matches for comparing personal labels with a scorer, without guessing their meaning. */
  labelAliases?: Record<string, string>;
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
  imported?: boolean;
  kind?: "evaluation" | "training";
  provenance?: { kind: string; path: string; sha256: string; identity?: string; note?: string };
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

/** A file of old results and the column names the person explicitly mapped. */
export interface ResearchImportRequest {
  path: string;
  format?: "jsonl" | "json" | "csv" | "tsv" | "trainer";
  title?: string;
  columns?: Record<string, string>;
  scoreColumns?: string[];
  modelId?: string;
  evaluation?: EvaluationSpec;
  expectedSha256?: string;
}

/** What an import would read, before it creates any record. */
export interface ResearchImportPreview {
  samples: number;
  metrics: number;
  preview: SampleLine[];
  provenance: { path: string; sha256: string; identity: string; note: string };
}

/** One training event, separate from a scored evaluation sample. */
export interface TrainingMetric { step: number; values: Record<string, number> }

/** A fixed pair of runs/models and a numeric score, with explicit score direction. */
export interface PairedComparisonRequest {
  left: { runId: string; modelId?: string };
  right: { runId: string; modelId?: string };
  scorer: string;
  higherIsBetter?: boolean;
  sliceField?: string;
  slice?: string;
  only?: string;
  cursor?: number;
  save?: boolean;
  title?: string;
}

/** Prompt-weighted differences; trials of the same prompt are not independent observations. */
export interface PairedSummary {
  paired: number; independentSamples: number; meanDelta: number | null; interval95: [number, number] | null;
  improved: number; regressed: number; unchanged: number; missingLeft: number; missingRight: number; excluded: number;
}

export interface PairedComparison {
  comparison: Comparison;
  summary: PairedSummary;
  slices: (PairedSummary & { name: string })[];
  items: { sampleId: string; trial: number; slice: string; delta: number | null; change: string; reason: string | null; left: SampleLine | null; right: SampleLine | null }[];
  next: number | null; total: number; note: string;
  saved?: ResearchRecord & { title: string; members: unknown[] };
}

/** A saved regression cohort, including samples beyond a visible comparison page. */
export interface CounterexampleSet extends ResearchRecord {
  title: string; request: PairedComparisonRequest; summary: PairedSummary;
  members: { sampleId: string; trial: number; delta: number; slice: string }[];
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
  /** The word `expected` is scored against, for a scorer that compares two. */
  alternative?: unknown;
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
  labels: Record<string, { sampleId: string; trial: number; modelId?: string | null; label: string; note?: string; agreesWithScorer?: boolean | null }>;
  agreement: { labeled: number; compared: number; agreed: number };
}

export interface ResearchPolicy {
  revision: number;
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

/**
 * Models as rows of a tree, parents before their children. A line of checkpoints stays at one depth, however long it gets; only a
 * model with several children goes in a level, and those children are `branch`es.
 */
export function lineageRows(models: ModelNode[]): { model: ModelNode; depth: number; branch: boolean }[] {
  const known = new Set(models.map((model) => model.id));
  const children = new Map<string, ModelNode[]>();
  for (const model of models) {
    if (model.parentId && known.has(model.parentId)) children.set(model.parentId, [...(children.get(model.parentId) ?? []), model]);
  }
  const rows: { model: ModelNode; depth: number; branch: boolean }[] = [];
  const visit = (model: ModelNode, depth: number, branch: boolean) => {
    rows.push({ model, depth, branch });
    const own = children.get(model.id) ?? [];
    for (const child of own) visit(child, own.length > 1 ? depth + 1 : depth, own.length > 1);
  };
  for (const model of models) if (!model.parentId || !known.has(model.parentId)) visit(model, 0, false);
  return rows;
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
  samples: {
    sampleId: string;
    expected: string | null;
    /** What the expected word is scored against, when the program said. */
    alternative?: string | null;
    top: string;
    expectedLogProb: number | null;
    margin?: number | null;
    byLayer: { layer: number; top: string; expectedLogProb: number | null; margin?: number | null }[];
  }[];
  recordedAt?: string;
}

/** Two models read on one prompt, layer by layer. */
export interface ModelCompareView {
  modelId: string;
  otherModelId: string;
  measure: string;
  tokens: string[];
  layers: { layer: number; values: number[] }[];
  otherLayers: { layer: number; values: number[] }[];
  top: string;
  otherTop: string;
  recordedAt?: string;
}

/** A corrupted prompt with each layer and position restored from a clean one: how much of the margin comes back, 0 none and 1 all, beside a random control. */
export interface PromptPatchView {
  modelId: string;
  tokens: string[];
  corruptedTokens: string[];
  expected: string;
  alternative: string;
  cleanMargin: number;
  corruptedMargin: number;
  cleanTop: string;
  corruptedTop: string;
  layers: number[];
  recovery: number[][];
  control: number[][];
  recordedAt?: string;
}

/** One layer's values less the other model's. The caller's two readings share their tokens, since the runtime refuses otherwise. */
export function readingDifference(left: ModelCompareView["layers"], right: ModelCompareView["layers"]): ModelCompareView["layers"] {
  return left.flatMap((row) => {
    const other = right.find((item) => item.layer === row.layer);
    return other ? [{ layer: row.layer, values: row.values.map((value, index) => Number((value - (other.values[index] ?? 0)).toFixed(4))) }] : [];
  });
}

/** The furthest any random change of the same size moved the margin, in either direction. Patches at or below it say nothing. */
export function controlCeiling(view: PromptPatchView): number {
  return Math.max(0, ...view.control.flat().map(Math.abs));
}

/** The layer and position that bring back the most, if any brings back more than the control does. */
export function strongestPatch(view: PromptPatchView): { layer: number; token: string; position: number; recovery: number } | null {
  const ceiling = controlCeiling(view);
  let best: { layer: number; token: string; position: number; recovery: number } | null = null;
  view.recovery.forEach((row, rowIndex) => row.forEach((recovery, position) => {
    if (recovery > ceiling && (!best || recovery > best.recovery)) best = { layer: view.layers[rowIndex] ?? rowIndex, token: view.tokens[position] ?? "", position, recovery };
  }));
  return best;
}

/** One layer on one prompt read through a sparse autoencoder: its strongest features per token, by id, and how well it rebuilt the prompt. */
export interface FeaturesView {
  modelId: string;
  layer: number;
  tokens: string[];
  top: string;
  sae: { release: string | null; id: string | null; path: string | null; hookName: string; width: number; trainedOn: string | null; startTokenAdded: boolean; centered: boolean };
  reconstruction: { varianceExplained: number | null; relativeError: number; meanActiveFeatures: number; tokensLeftOut: number };
  /** The strongest firing features at each token. A special token has none: an SAE is not read there. */
  features: { feature: number; activation: number }[][];
  expected: string | null;
  alternative: string | null;
  /** The margin as the model has it, and with the unmodified reconstruction spliced in. */
  margins: { plain: number; spliced: number; spliceChange: number } | null;
  ablation: (FeatureEffect & { control: FeatureEffect | null; controlSeed: number }) | null;
  recordedAt?: string;
}

/** A feature set to zero at every token: its strongest activation, the margin, and how far that is from the reconstruction's. */
export interface FeatureEffect {
  feature: number;
  activation: number;
  margin: number;
  change: number;
}

/** Below this share of variance explained, a prompt's features say little. A rule of thumb, shown as one. */
export const POOR_RECONSTRUCTION = 0.5;

/** Whether an SAE rebuilt a prompt too poorly for its features to say much. */
export function reconstructionIsPoor(view: FeaturesView): boolean {
  const explained = view.reconstruction.varianceExplained;
  return explained === null ? view.reconstruction.relativeError > 0.5 : explained < POOR_RECONSTRUCTION;
}

/** Every feature seen on a prompt, strongest first: its peak, and the tokens it is among the strongest at. That is all that is known of it here. */
export function featurePeaks(view: FeaturesView): { feature: number; peak: number; tokens: string[] }[] {
  const found = new Map<number, { feature: number; peak: number; tokens: string[] }>();
  view.features.forEach((row, position) => {
    for (const { feature, activation } of row) {
      const entry = found.get(feature) ?? { feature, peak: 0, tokens: [] };
      entry.peak = Math.max(entry.peak, activation);
      entry.tokens.push(view.tokens[position] ?? String(position));
      found.set(feature, entry);
    }
  });
  return [...found.values()].sort((left, right) => right.peak - left.peak);
}

/** How an ablation reads: beyond both the control and the error of splicing, or lost in one of them. No verdict on what the feature is. */
export type AblationStanding = "beyond" | "control" | "splice" | "no-control";

export function ablationStanding(view: FeaturesView): AblationStanding | null {
  const { ablation, margins } = view;
  if (!ablation || !margins) return null;
  if (!ablation.control) return "no-control";
  const size = Math.abs(ablation.change);
  if (size <= Math.abs(ablation.control.change)) return "control";
  if (size <= Math.abs(margins.spliceChange)) return "splice";
  return "beyond";
}

const ABLATION_TEXT: Record<AblationStanding, string> = {
  beyond: "That is further than both the control and the error of splicing.",
  control: "That is no further than the control went, so it says nothing about this feature.",
  splice: "It is further than the control, but no further than splicing alone moved the margin, so the error of the reconstruction could account for it.",
  "no-control": "No other feature fires on this prompt, so there is no control to read it against.",
};

/** What an ablation came to, in a sentence, against what it must be read with. */
export function ablationText(view: FeaturesView): string {
  const standing = ablationStanding(view);
  return standing ? ABLATION_TEXT[standing] : "";
}

/** What reading features found, in words fit to keep as an observation. Ids only, since a name would be a guess. */
export function featuresText(view: FeaturesView, modelName: string): string {
  const { reconstruction, sae, ablation, margins } = view;
  const which = sae.path ?? `${sae.release} / ${sae.id}`;
  const explained = reconstruction.varianceExplained === null ? "no variance to explain on one token" : `${percentText(reconstruction.varianceExplained)} of variance explained`;
  const parts = [`SAE ${which} (${sae.hookName}) on ${modelName}, layer ${view.layer}: ${explained}, relative error ${reconstruction.relativeError}, ${reconstruction.meanActiveFeatures} features active per token.`];
  if (reconstructionIsPoor(view)) parts.push("The reconstruction is poor, so the features say little.");
  const strongest = featurePeaks(view).slice(0, 3).map((item) => `${item.feature} (${item.peak} at ${item.tokens.map((token) => JSON.stringify(token)).join(", ")})`);
  if (strongest.length) parts.push(`Strongest features: ${strongest.join("; ")}.`);
  if (ablation && margins) {
    const control = ablation.control ? ` A random feature of similar activation, ${ablation.control.feature}, moved it ${signedText(ablation.control.change)}.` : "";
    parts.push(`Margin of ${JSON.stringify(view.expected)} over ${JSON.stringify(view.alternative)}: ${margins.plain}, and ${margins.spliced} with the reconstruction spliced in, a change of ${signedText(margins.spliceChange)}. Ablating feature ${ablation.feature} moved it ${signedText(ablation.change)} from there.${control} ${ablationText(view)}`);
  }
  parts.push("A prompt typed by hand, one case: not a measurement of the model in general.");
  return parts.join(" ");
}

/** A change with its sign, so a fall and a rise read apart. */
export function signedText(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

/** What a patch across prompts found, in words fit to keep as an observation. */
export function promptPatchText(view: PromptPatchView, modelName: string): string {
  const best = strongestPatch(view);
  const margins = `Margin of ${JSON.stringify(view.expected)} over ${JSON.stringify(view.alternative)} on ${modelName}: clean ${view.cleanMargin}, corrupted ${view.corruptedMargin}.`;
  const ceiling = `A random change of the same size moved at most ${percentText(controlCeiling(view))}.`;
  if (!best) return `${margins} No layer and position brought back more than the control. ${ceiling} Prompts typed by hand, one pair: not a measurement of the model in general.`;
  return `${margins} Restoring layer ${best.layer} at position ${best.position} (${JSON.stringify(best.token)}) brought back ${percentText(best.recovery)}. ${ceiling} Prompts typed by hand, one pair: not a measurement of the model in general.`;
}

/** A share as a percentage, whole enough to read. */
function percentText(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** What counts as brought back: the logit margin when every sample has one, since a two-way scorer judges that, else the top token. */
export type RestoreMeasure = "margin" | "top";

export function sweepMeasure(view: SweepView): RestoreMeasure {
  const hasMargins = view.samples.length > 0 && view.samples.every((sample) => sample.byLayer.length > 0 && sample.byLayer.every((item) => typeof item.margin === "number"));
  return hasMargins ? "margin" : "top";
}

/** How a measure reads after a count, in words. */
export const RESTORE_MEASURE_TEXT: Record<RestoreMeasure, string> = { margin: "by logit margin", top: "by top token" };

/** One thing saved under a run's inside folder: a reading of one sample, or a sweep. */
export type InsideItem = (({ kind: "reading" } & ActivationView) | ({ kind: "sweep" } & SweepView) | ({ kind: "compare" } & ModelCompareView) | ({ kind: "prompts" } & PromptPatchView) | ({ kind: "features" } & FeaturesView)) & {
  /** Whether this runtime's helper made it; a corrected helper leaves earlier results in place. */
  current?: boolean;
  /** What names it among a run's records. */
  key?: string;
};

/**
 * The sweeps into a model by this runtime's helper, with every tied best layer; zero recoveries do not identify a best
 * layer. An earlier helper's sweep can be wrong, so it never speaks for the model here. `earlierSweeps` counts them.
 */
export function mechanismOf(items: InsideItem[], modelId: string): { sourceModelId: string | null; layers: number[]; restored: number; of: number; measure: RestoreMeasure; recordedAt?: string }[] {
  return items.flatMap((item) => {
    if (item.kind !== "sweep" || item.current === false || item.targetModelId !== modelId || !item.layers.length) return [];
    const totals = restoredByLayer(item);
    const restored = Math.max(...totals);
    const layers = restored > 0 ? item.layers.filter((_, index) => totals[index] === restored) : [];
    return [{ sourceModelId: item.sourceModelId, layers, restored, of: item.samples.length, measure: sweepMeasure(item), recordedAt: item.recordedAt }];
  });
}

/** How many sweeps into a model came from a helper that has since changed. They stay with the run. */
export function earlierSweeps(items: InsideItem[], modelId: string): number {
  return items.filter((item) => item.kind === "sweep" && item.current === false && item.targetModelId === modelId).length;
}

/** Whether a layer's patch brings a sample back, by this measure: what "restored" means here, said once. */
export function restores(sample: SweepView["samples"][number], layer: number, measure: RestoreMeasure = "top"): boolean {
  const at = sample.byLayer.find((item) => item.layer === layer);
  if (!at) return false;
  return measure === "margin" ? typeof at.margin === "number" && at.margin > 0 : Boolean(sample.expected && at.top === sample.expected);
}

/** How many samples each layer restores, in the sweep's layer order, by its own measure unless another is asked for. */
export function restoredByLayer(view: SweepView, measure: RestoreMeasure = sweepMeasure(view)): number[] {
  return view.layers.map((layer) => view.samples.filter((sample) => restores(sample, layer, measure)).length);
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
  /** A changed/truncated consumed prefix caused the counters to restart. Absent in older resource records. */
  samplesRewrites?: number;
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
  const generation = points.at(-1)?.samplesRewrites ?? 0;
  const recent = points.slice(-window).filter((point) => (point.samplesRewrites ?? 0) === generation);
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
  status: "running" | "completed" | "failed" | "interrupted" | "timed_out";
  timeoutSeconds?: number;
  error?: string;
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

/** A page of a run's samples. */
export interface SamplePage {
  items: SampleItem[];
  next: number | null;
}

/** How many lines the Samples list loads by itself; a larger run goes on with More. */
export const MOST_LISTED_LINES = 20_000;

/** Reads pages from a cursor until the end, or until `most` lines. Stops early, keeping nothing further, when `live` turns false. */
export async function readSamplePages(read: (cursor: number) => Promise<SamplePage>, options: { from?: number; most?: number; live?: () => boolean; onPage?: (page: SamplePage) => void } = {}): Promise<SamplePage> {
  const { from = 0, most = MOST_LISTED_LINES, live = () => true, onPage } = options;
  const items: SampleItem[] = [];
  let cursor: number | null = from;
  while (cursor !== null && items.length < most) {
    const page: SamplePage = await read(cursor);
    if (!live()) break;
    items.push(...page.items);
    cursor = page.next;
    onPage?.(page);
  }
  return { items, next: cursor };
}

/** Whether a change to the records changes which lines a filter holds. Scores are sealed; only labels move, and only disputes depend on them. */
export function changeRereadsList(only: "all" | "disputed" | "errors"): boolean {
  return only === "disputed";
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
  /** A sample to look at on the Inspect screen, with the run it came from. */
  inspect?: { runId: string; modelId: string | null; input: string; expected?: string; alternative?: string };
}

/**
 * A sample's id, split so that a list too narrow for it can leave out the middle: long ids tend to differ at both ends, as in
 * `shuffled-lr0.0001-s0-step00020`. The end is the last part after a separator, or the last few characters of an id with none.
 */
export function sampleIdParts(id: string): { start: string; end: string } {
  const separator = Math.max(id.lastIndexOf("-"), id.lastIndexOf("_"), id.lastIndexOf("/"));
  const cut = separator > 0 && id.length - separator <= 16 ? separator : Math.max(0, id.length - 6);
  return { start: id.slice(0, cut), end: id.slice(cut) };
}
