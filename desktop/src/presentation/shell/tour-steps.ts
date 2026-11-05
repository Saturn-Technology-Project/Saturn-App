import type { Screen } from "./navigation.js";

/** One stop of the tour: what is boxed, what is said about it, and which screen shows meanwhile. */
export interface TourStep {
  id: string;
  /** The `data-tour` value of the element to box; none boxes nothing and centers the card. */
  target: string | null;
  /** The screen to show while this step is up. */
  screen?: Screen;
  title: string;
  text: string;
}

/** The tour: every screen in the order of the rail, then the first steps of a piece of research. */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    target: null,
    title: "A workbench for AI research",
    text: "Read the method, write the code yourself, run the experiment and inspect every sample, on your own computer. This tour boxes each part of Saturn and says what it is for, then helps you start a piece of research. Skip it any time; it is in Commands (⌘K) as \"Take the tour\".",
  },
  {
    id: "rail",
    target: "rail",
    title: "The screens",
    text: "Saturn is organized around your research, not around chats: questions, code, models, experiments, samples, long tasks, protection and the environment. ⌘1 to ⌘8 switch between them.",
  },
  {
    id: "home",
    target: "rail-Home",
    screen: "Home",
    title: "Home: where the work stands",
    text: "The question you are on, its hypotheses and their verdicts, what changed since you last looked, and what is still open. A verdict is yours to set; a run that finishes says only that it executed.",
  },
  {
    id: "workspace",
    target: "rail-Workspace",
    screen: "Workspace",
    title: "Workspace: code beside its results",
    text: "Open a file, write it, and run the experiment's command. Below the editor: the run, what it cost, its samples, your findings, a look inside the model, and a terminal. Each file has a mode: Manual (you write it), Pair (the assistant proposes, you approve) or Delegate (an agent may change it, recorded).",
  },
  {
    id: "assistant",
    target: "assistant",
    title: "The research assistant",
    text: "A panel beside your work. It does what the open file's mode allows: in Manual it only reads and explains; in Pair it proposes changes you approve; in Delegate it hands work to a task. Samples it is given are marked as data, never as instructions.",
  },
  {
    id: "lineage",
    target: "rail-Lineage",
    screen: "Lineage",
    title: "Lineage: checkpoints and branches",
    text: "Connect pretraining checkpoints to fine-tuned and preference-trained branches. Each node shows what was last measured on it, and Saturn warns when two nodes were not measured the same way, so a difference in method never reads as a difference in the model.",
  },
  {
    id: "experiments",
    target: "rail-Experiments",
    screen: "Experiments",
    title: "Experiments: frozen and traceable",
    text: "Running freezes a version: the code, data, scorer and models exactly as they were. Here you see each model's score, where the score comes from (what the scorer judged, what you disputed, what was excluded), and you write the conclusion, kept with the run it rests on.",
  },
  {
    id: "samples",
    target: "rail-Samples",
    screen: "Samples",
    title: "Samples: what the model actually did",
    text: "One sample across every model that saw it, with the scorer's own word next to your label. Your label never overwrites a score. Keep a sample as a counterexample, or look inside: read activations at every layer, or patch a layer in from another model.",
  },
  {
    id: "tasks",
    target: "rail-Tasks",
    screen: "Tasks",
    title: "Tasks: long work, apart",
    text: "Batch runs and cleanups go to an agent in its own worktree. It cannot touch Manual or locked files, and nothing reaches the project until you merge it. When it wants to change a locked file, you decide: release it for the next version, keep it, or edit it yourself.",
  },
  {
    id: "protection",
    target: "rail-Protection",
    screen: "Protection",
    title: "Protection: what was refused and what changed",
    text: "Every refusal and every change noticed outside Saturn's tools is recorded here, with what each backend can and cannot enforce. Modes are a workflow constraint, not a security boundary, and this screen says so plainly.",
  },
  {
    id: "environment",
    target: "rail-Environment",
    screen: "Environment",
    title: "Environment: the Python it runs in",
    text: "Name the Python your experiments run with, ask it for its version, packages and devices, and freeze the lock files with each version, so a changed environment is a new version rather than a surprise.",
  },
  {
    id: "start",
    target: "project",
    screen: "Home",
    title: "Start a piece of research",
    text: "Research lives in a project folder, as plain files under .saturn/research that you can keep. Choose the folder, write down the question you are trying to answer, and the rest connects back to it.",
  },
];
