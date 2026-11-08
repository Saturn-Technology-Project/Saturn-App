// The first study, as steps on Home: what a new project still lacks, in the order a study needs it, and what each
// step offers to do next. Done is read from the records, never ticked by hand.
import { t as translate, type TextParams } from "./i18n.ts";

type Words = (text: string, params?: TextParams) => string;

/** What the records say about a project, as far as the first study needs to know. */
export interface StudyProgress {
  /** The project's Python was named and checked. */
  environmentChecked: boolean;
  questions: number;
  hypotheses: number;
  /** Experiments written here, and results brought in. */
  experiments: number;
  imported: number;
  /** Runs Saturn made that have results. */
  runsWithResults: number;
  /** Samples a person labeled. */
  labeled: number;
  findings: number;
}

/** Where a step's action goes. */
export type StepAction =
  | { kind: "screen"; screen: "Environment" | "Workspace" | "Samples" | "Experiments" }
  | { kind: "field"; field: "question" | "hypothesis" }
  | { kind: "assistant"; prompt: string };

/** One step of the first study. */
export interface StudyStep {
  id: "environment" | "question" | "hypothesis" | "results" | "run" | "samples" | "finding";
  title: string;
  why: string;
  done: boolean;
  actions: { label: string; action: StepAction }[];
}

/** What the assistant is asked when it brings existing results in; the person reads it before sending. */
export function importPrompt(t: Words = translate): string {
  return t(
    "I already have results from earlier work in this project. Read the importing-results skill first. Then find the result files (JSONL, JSON, CSV or TSV, or a Hugging Face trainer_state.json), preview how each would come in, and tell me which columns you would map to the sample ID, input, output and scores. Import them only after I agree, and keep anything you do not know about how they were measured as unknown.",
  );
}

/** What the assistant is asked when a person starts from two evaluations they already have: the quickest way to a
 * result worth reading, before any of Saturn's structure. */
export function comparePrompt(t: Words = translate): string {
  return t(
    "I have two evaluation results on the same samples, from two checkpoints or two models. Read the importing-results and paired-comparisons skills first. Find the two result files, preview how each would come in, and tell me which column is the stable sample ID and which is the score. Import them only after I agree. Then compare them by sample ID, the earlier one on the left, and show me the samples that regressed, the largest drops first. Say what is unknown about how each was measured.",
  );
}

/** Whether the project has no results yet, so starting from two evaluations is offered before the checklist. */
export function offersComparison(progress: StudyProgress): boolean {
  return progress.experiments === 0 && progress.imported === 0;
}

/** What the assistant is asked when it helps write and run the first experiment. */
export function firstExperimentPrompt(t: Words = translate): string {
  return t(
    "Help me write the first experiment for this project's question. Read the experiment-program and freeze-and-run skills first. Propose a small program that writes one sample line per example to SATURN_RUN_SAMPLES, try it on a few examples, then freeze and run it.",
  );
}

/** The steps, in order, with whether each is done. */
export function firstStudySteps(progress: StudyProgress, t: Words = translate): StudyStep[] {
  return [
    {
      id: "environment",
      title: t("Check the project's Python"),
      why: t("Experiments and the look inside a model run with it. Saturn can make one in the project and install what research code needs."),
      done: progress.environmentChecked,
      actions: [{ label: t("Open Environment"), action: { kind: "screen", screen: "Environment" } }],
    },
    {
      id: "question",
      title: t("Write down the question"),
      why: t("Everything else connects back to it: hypotheses, experiments and findings."),
      done: progress.questions > 0,
      actions: [{ label: t("Write it below"), action: { kind: "field", field: "question" } }],
    },
    {
      id: "hypothesis",
      title: t("Write a hypothesis before any result"),
      why: t("A prediction written after seeing the number is only a description. The verdict is yours to set later."),
      done: progress.hypotheses > 0,
      actions: [{ label: t("Write it below"), action: { kind: "field", field: "hypothesis" } }],
    },
    {
      id: "results",
      title: t("Bring in results you have, or write an experiment"),
      why: t("Results from earlier work come in marked as imported, so they are never mistaken for a run Saturn made. The assistant can find and map them for you; you approve the import."),
      done: progress.experiments > 0 || progress.imported > 0,
      actions: [
        { label: t("Ask the assistant to import them"), action: { kind: "assistant", prompt: importPrompt(t) } },
        { label: t("Compare two evaluations"), action: { kind: "assistant", prompt: comparePrompt(t) } },
        { label: t("Write an experiment"), action: { kind: "screen", screen: "Workspace" } },
      ],
    },
    {
      id: "run",
      title: t("Run an experiment"),
      why: t("Running freezes a version: the code, data, scorer and models exactly as they were, so the result can be traced."),
      done: progress.runsWithResults > 0,
      actions: [
        { label: t("Run it in the Workspace"), action: { kind: "screen", screen: "Workspace" } },
        { label: t("Ask the assistant to help"), action: { kind: "assistant", prompt: firstExperimentPrompt(t) } },
      ],
    },
    {
      id: "samples",
      title: t("Read the samples and label some"),
      why: t("A mean hides what the model actually did. Your labels never overwrite a score."),
      done: progress.labeled > 0,
      actions: [{ label: t("Open Samples"), action: { kind: "screen", screen: "Samples" } }],
    },
    {
      id: "finding",
      title: t("Write what you found"),
      why: t("A finding stays with the runs it rests on, so it can be checked later."),
      done: progress.findings > 0,
      actions: [{ label: t("Open Experiments"), action: { kind: "screen", screen: "Experiments" } }],
    },
  ];
}

/** The first step not done yet, or null when the first study is complete. */
export function nextStep(steps: readonly StudyStep[]): StudyStep | null {
  return steps.find((step) => !step.done) ?? null;
}
