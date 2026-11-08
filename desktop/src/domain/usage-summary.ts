// How someone has used Saturn, from their own records, for them to share with whoever asked: which days they worked, in
// how many projects, and how much they ran, brought in and wrote down. No names, paths, text or results are in it.
import { t as translate, type TextParams } from "./i18n.ts";

type Words = (text: string, params?: TextParams) => string;

/** What one project's records say, as far as the summary needs. */
export interface ProjectRecords {
  runs: { createdAt: string; imported?: boolean }[];
  experiments: { createdAt: string; imported?: boolean }[];
  questions: { createdAt: string }[];
  findings: { createdAt: string }[];
}

/** The totals across projects, and the days anything was recorded. */
export interface UsageSummary {
  /** Local calendar days with any record made, oldest first. */
  days: string[];
  /** Projects with any research record. */
  projects: number;
  /** Runs Saturn made, and results brought in. */
  runs: number;
  imported: number;
  experiments: number;
  questions: number;
  findings: number;
}

/** A time as the local calendar day it fell on, or nothing when it is not a time. */
export function localDay(at: string): string | null {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const two = (value: number) => String(value).padStart(2, "0");
  return `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
}

/** The summary of every project's records. */
export function usageSummary(projects: ProjectRecords[], day: (at: string) => string | null = localDay): UsageSummary {
  const days = new Set<string>();
  const summary: UsageSummary = { days: [], projects: 0, runs: 0, imported: 0, experiments: 0, questions: 0, findings: 0 };
  for (const project of projects) {
    const records = [...project.runs, ...project.experiments, ...project.questions, ...project.findings];
    if (!records.length) continue;
    summary.projects += 1;
    for (const record of records) {
      const date = day(record.createdAt);
      if (date) days.add(date);
    }
    summary.runs += project.runs.filter((run) => !run.imported).length;
    summary.imported += project.runs.filter((run) => run.imported).length;
    summary.experiments += project.experiments.filter((experiment) => !experiment.imported).length;
    summary.questions += project.questions.length;
    summary.findings += project.findings.length;
  }
  summary.days = [...days].sort();
  return summary;
}

/** The summary as plain text to paste into a message. */
export function usageText(summary: UsageSummary, version: string, t: Words = translate): string {
  const lines = [
    t("Saturn {version}, usage from this computer's research records", { version }),
    t("Days with work: {count}", { count: summary.days.length }) + (summary.days.length ? ` (${summary.days.join(", ")})` : ""),
    t("Projects with research: {count}", { count: summary.projects }),
    t("Runs made in Saturn: {count}", { count: summary.runs }),
    t("Results brought in: {count}", { count: summary.imported }),
    t("Experiments written: {count}", { count: summary.experiments }),
    t("Questions: {count}", { count: summary.questions }),
    t("Findings: {count}", { count: summary.findings }),
  ];
  return lines.join("\n");
}
