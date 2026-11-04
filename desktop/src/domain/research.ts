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
