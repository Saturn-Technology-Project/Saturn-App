import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  byAssistant,
  isRunActive,
  runOfExperiment,
  runStatusLabel,
  sampleIdParts,
  sampleText,
  tabAfterClosing,
  scoreText,
  type ExperimentDraft,
  type ExperimentRun,
  type FrozenVersion,
  type Finding,
  type FindingKind,
  type ModelNode,
  type Question,
  type SampleItem,
} from "../../domain/research.js";
import { EMPTY_TREE, foldersToRead, keyMove, parentOf, refreshed, revealed, toggled, treeRows, type TreeEntry, type TreeState } from "../../domain/file-tree.js";
import { newFileContent, renamedFileSession } from "../../domain/workspace-files.js";
import { t } from "../../domain/i18n.js";
import { isNotebookPath, NOTEBOOK_SIZE_LIMIT } from "../../domain/notebook.js";
import { LookInside } from "../samples/LookInside.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { classes } from "../ui/base/classes.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { Textarea } from "../ui/base/Textarea.js";
import { messageOf, Tabs } from "../ui/Parts.js";
import { Split } from "../ui/Split.js";
import { NotebookEditor } from "./NotebookEditor.js";
import { Resources } from "./Resources.js";
import { DocumentView } from "./DocumentView.js";
import { SourceEditor } from "./SourceEditor.js";
import { EditorDocuments } from "../../domain/code-editor.js";
import { LanguageServices } from "../../application/language-services.js";
import { languageOf } from "../../domain/code-languages.js";
import { Terminal } from "./Terminal.js";
import { FileActionDialog, type FileAction } from "./FileActionDialog.js";
import { Artifacts } from "../experiments/Artifacts.js";
import { RunControls } from "../experiments/RunControls.js";
import { AgentBrowserView, useAgentBrowser } from "../assistant/AgentBrowser.js";
import { askToConfirm } from "../../infrastructure/confirm.js";
import { browserHost } from "../../domain/model.js";

const service = desktop.research;
const FINDING_LABELS: Record<FindingKind, string> = { observation: t("Observation"), ai_suggestion: t("AI suggestion"), conclusion: t("Conclusion") };
/** The panels under the editor, by the name each shows: the tabs show these names. */
const PANEL = { run: t("Run"), resources: t("Resources"), samples: t("Samples"), findings: t("Findings"), activations: t("Activations"), artifacts: t("Artifacts"), terminal: t("Terminal") };
const PANELS = Object.values(PANEL);
type Panel = string;
/** A file or a list entry in the sidebar and the sample list: monospaced, left aligned, and it wraps rather than cuts. */
/** One row of the file tree: indented by depth, the open file marked. */
const TREE_ROW = "group flex min-h-[26px] w-full cursor-default items-center gap-1.5 rounded-md pr-2 text-left font-mono text-xs text-muted-foreground outline-none select-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
/** A sample in the list: one line, its id's start giving way so the end, where ids tend to differ, stays in view. */
const SAMPLE_ENTRY = "relative flex h-7 w-full flex-none cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 text-left text-xs before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full";
/** A heading inside a sample's preview. */
const SAMPLE_LABEL = "mb-1 text-[11px] font-medium text-muted-foreground";
/** A sample's input or output: plain text in a box of its own. */
const SAMPLE_TEXT = "m-0 rounded-md border border-border bg-panel px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]";
/** A question in the sidebar: up to three lines behind a rule of its own, so one question never runs into the next. */
const QUESTION_ENTRY = "group flex w-full cursor-pointer gap-2 rounded-md border-0 bg-transparent px-1.5 py-1.5 text-left text-foreground hover:bg-muted";
const ENTRY = "h-auto min-h-7 w-full flex-wrap justify-start gap-x-2 gap-y-0.5 px-2 py-[3px] text-left font-mono text-xs font-normal whitespace-normal [overflow-wrap:anywhere]";
/** Output as plain monospaced text that wraps. */
const OUTPUT_TEXT = "font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]";
/** A line of small, quiet text. */
const MUTED = "text-xs text-muted-foreground";
/** The experiment bar's choice for an experiment not made yet: the next run makes it. */
const NEW_EXPERIMENT = "new";
/** A line of small text about something that needs care. */
const WARNING = "text-xs text-wait";
/** Unsaved text is kept on this device up to this size: a notebook's images would not fit, and writing them on every change is slow. */
const LARGEST_DRAFT = 1024 * 1024;

/** The file open in the editor. `revision` is null for a file not saved yet. */
interface OpenFile {
  path: string;
  initial: string;
  revision: string | null;
  /** Moves on when the editor must take new content from outside. */
  generation: number;
  /** A paper or a figure, shown and never edited. */
  document?: { mime: string; data: string };
}

/** What the workspace is looking at, which the assistant can be given. */
export interface WorkspaceFocus {
  file: string | null;
  selection: { text: string; line: number } | null;
  run: ExperimentRun | null;
  errorOutput: string;
  sample: SampleItem | null;
}

function isConflict(error: unknown): boolean {
  return /changed since/i.test(messageOf(error));
}

/** Files, the editor, and what a run produced under them. The assistant sits beside all of it. */
export function Workspace(props: ScreenProps & { onFocus: (focus: WorkspaceFocus) => void }) {
  const projectId = props.project.id;
  const { notify, onFocus } = props;
  const session = useRef(service.loadSession(projectId));
  const [tree, setTree] = useState<TreeState>(() => {
    const opened: TreeState = { ...EMPTY_TREE, open: session.current.treeOpen ?? [] };
    return session.current.file ? revealed(opened, session.current.file) : opened;
  });
  const [focusedRow, setFocusedRow] = useState(0);
  const [fileQuery, setFileQuery] = useState("");
  const [foundFiles, setFoundFiles] = useState<string[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(session.current.file ?? null);
  const [fileAction, setFileAction] = useState<FileAction | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const content = useRef("");
  const editorDocuments = useRef(new EditorDocuments());
  const [dirty, setDirty] = useState(false);
  // The files open as tabs, in the order they were opened; one of them is in the editor. A tab left with unsaved text
  // keeps it here until it is shown again, saved or closed.
  const [tabs, setTabs] = useState<string[]>(() => session.current.tabs ?? (session.current.file ? [session.current.file] : []));
  const unsaved = useRef(new Map<string, { content: string; revision: string | null }>());
  const editing = useRef<{ open: OpenFile | null; dirty: boolean }>({ open: null, dirty: false });
  editing.current = { open, dirty };
  // The centre shows a file, or the assistant's browser live as a tab of its own, which comes up when the assistant opens a
  // page and stays until it is closed.
  const [centre, setCentre] = useState<"editor" | "browser">("editor");
  const [browserTab, setBrowserTab] = useState(false);
  const browser = useAgentBrowser();
  const browsing = Boolean(browser.state?.open);
  useEffect(() => {
    if (!browsing) return;
    setBrowserTab(true);
    setCentre("browser");
  }, [browsing]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [selection, setSelection] = useState<WorkspaceFocus["selection"]>(null);
  const [experiment, setExperiment] = useState<ExperimentDraft | null>(null);
  const [command, setCommand] = useState("");
  const [run, setRun] = useState<ExperimentRun | null>(null);
  const [samples, setSamples] = useState<SampleItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [selectedOffset, setSelectedOffset] = useState<number | null>(null);
  const [errorOutput, setErrorOutput] = useState("");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [findingText, setFindingText] = useState("");
  const [findingKind, setFindingKind] = useState<FindingKind>("observation");
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>(PANEL.run);
  const [sidebar, setSidebar] = useState<{ questions: Question[]; models: ModelNode[]; drafts: ExperimentDraft[]; versions: FrozenVersion[] }>({ questions: [], models: [], drafts: [], versions: [] });

  const remember = useCallback(
    (changes: Partial<typeof session.current>) => {
      session.current = { ...session.current, ...changes };
      service.saveSession(projectId, session.current);
    },
    [projectId],
  );
  useEffect(() => remember({ tabs }), [remember, tabs]);

  /** A folder's entries, or null when it is gone or is not a folder. */
  const readFolder = useCallback(
    async (path: string): Promise<TreeEntry[] | null> => {
      try {
        const view = await service.readSource(projectId, path);
        return view.kind === "directory" ? view.entries : null;
      } catch {
        return null;
      }
    },
    [projectId],
  );

  // Open folders are read when they are first shown.
  const pending = foldersToRead(tree).join("\n");
  useEffect(() => {
    if (!pending) return undefined;
    let live = true;
    const paths = pending.split("\n");
    void Promise.all(paths.map(async (path) => [path, await readFolder(path)] as const)).then((read) => {
      if (live) setTree((current) => refreshed(current, Object.fromEntries(read)));
    });
    return () => {
      live = false;
    };
  }, [pending, readFolder]);

  // Which folders are open is kept on this device, so the tree reopens as it was.
  useEffect(() => {
    if (JSON.stringify(session.current.treeOpen ?? []) !== JSON.stringify(tree.open)) remember({ treeOpen: [...tree.open] });
  }, [tree.open, remember]);

  // A turn of the assistant, a run, or another program may add, move or remove files: what is shown is read again.
  const shownTree = useRef(tree);
  shownTree.current = tree;
  const readShownFolders = useCallback(() => {
    const shown = Object.keys(shownTree.current.folders);
    return Promise.all(shown.map(async (path) => [path, await readFolder(path)] as const)).then((read) => setTree((latest) => refreshed(latest, Object.fromEntries(read))));
  }, [readFolder]);
  useEffect(() => {
    const stopFiles = desktop.live.onChange(readShownFolders);
    const stopRecords = desktop.live.onResearchChange(readShownFolders);
    // Files changed outside Saturn, in a terminal or an editor, show when the window comes back.
    window.addEventListener("focus", readShownFolders);
    return () => {
      stopFiles();
      stopRecords();
      window.removeEventListener("focus", readShownFolders);
    };
  }, [readShownFolders]);

  // Finding a file by name searches the whole project, not only the folders read so far.
  useEffect(() => {
    const query = fileQuery.trim();
    if (!query) {
      // Back to the tree, which may have missed files made meanwhile.
      setFoundFiles(null);
      readShownFolders();
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      desktop.projects
        .files(projectId, query)
        .then((paths) => live && setFoundFiles(paths))
        .catch(() => live && setFoundFiles([]));
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [fileQuery, projectId, readShownFolders]);

  const openFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      // The tab being left keeps its unsaved text, read now, before the editor changes.
      const leaving = editing.current;
      if (leaving.open && leaving.open.path !== path && leaving.dirty && !leaving.open.document) {
        unsaved.current.set(leaving.open.path, { content: content.current, revision: leaving.open.revision });
      }
      setCentre("editor");
      setTabs((current) => (current.includes(path) ? current : [...current, path]));
      try {
        const view = await service.readSource(projectId, path);
        if (view.kind === "document") {
          content.current = "";
          setDirty(false);
          setConflict(false);
          setSelection(null);
          setOpen((current) => ({ path, initial: "", revision: view.revision, generation: (current?.generation ?? 0) + 1, document: { mime: view.mime, data: view.data } }));
          setTree((current) => revealed(current, path));
          remember({ file: path });
          return;
        }
        if (view.kind !== "file") return;
        const draft = session.current.draft;
        const kept = unsaved.current.get(path);
        unsaved.current.delete(path);
        const restored = kept && kept.revision === view.revision ? kept.content : draft && draft.file === path && draft.revision === view.revision ? draft.content : null;
        content.current = restored ?? view.content;
        setDirty(restored !== null && restored !== view.content);
        setConflict(false);
        setSelection(null);
        setOpen((current) => ({ path, initial: content.current, revision: view.revision, generation: (current?.generation ?? 0) + 1 }));
        setTree((current) => revealed(current, path));
        remember({ file: path });
      } catch (error) {
        notify(messageOf(error));
      }
    },
    [notify, projectId, remember],
  );

  const languageServices = useRef<LanguageServices | null>(null);
  if (!languageServices.current) languageServices.current = new LanguageServices(service, projectId, openFile, notify);
  languageServices.current.callbacks(openFile, notify);
  useEffect(() => {
    const services = languageServices.current;
    return () => services?.close();
  }, []);

  /** A rename keeps the buffer in memory, including unsaved edits, while its saved file moves on disk. */
  function beginRename(path: string) {
    if (saving) return;
    const current = editing.current.open;
    const revision = current?.path === path ? current.revision : unsaved.current.get(path)?.revision;
    setFileAction({ kind: "rename", path, revision });
  }

  /** Creates a file or moves its saved bytes, then updates every local reference without discarding a draft. */
  async function applyFileAction(path: string) {
    if (!fileAction) return;
    if (fileAction.kind === "create") {
      const made = await service.writeSource(projectId, path, newFileContent(path), null);
      path = made.path;
      setFileQuery("");
      await openFile(path);
    } else {
      const from = fileAction.path;
      const moved = await service.renameSource(projectId, from, path, fileAction.revision);
      languageServices.current?.forget(from);
      path = moved.path;
      const kept = unsaved.current.get(from);
      if (kept) { unsaved.current.delete(from); unsaved.current.set(path, kept); }
      const current = editing.current;
      if (current.open?.path === from) {
        const next = { ...current.open, path, initial: content.current, revision: moved.revision ?? current.open.revision, generation: current.open.generation + 1 };
        editing.current = { ...current, open: next };
        setOpen(next);
        setConflict(false);
      }
      setTabs((current) => current.map((tab) => tab === from ? path : tab));
      remember(renamedFileSession(session.current, from, path));
      setSelectedPath(path);
      setFileQuery("");
    }
    setTree((current) => revealed(current, path));
    await readShownFolders();
  }

  const refreshRun = useCallback(
    async (runId: string) => {
      const found = (await service.runs(projectId)).items.find((item) => item.id === runId) ?? null;
      setRun(found);
      if (!found) return;
      const page = await service.samples(projectId, runId);
      setSamples(page.items);
      setNextCursor(page.next);
      setSelectedOffset((current) => current ?? page.items[0]?.offset ?? null);
      setErrorOutput((await service.log(projectId, runId, "stderr")).text);
    },
    [projectId],
  );

  const refreshFindings = useCallback(async () => {
    setFindings((await service.findings(projectId)).items);
  }, [projectId]);

  // What the sidebar lists beside the files: the project's questions, models and experiments, kept current with the records.
  const refreshSidebar = useCallback(async () => {
    const [questions, models, drafts, versions] = await Promise.all([service.questions(projectId), service.models(projectId), service.experiments(projectId), service.versions(projectId)]);
    setSidebar({ questions: questions.items, models: models.items, drafts: drafts.items, versions: versions.items });
  }, [projectId]);
  useEffect(() => {
    void refreshSidebar().catch(() => {});
    return desktop.live.onResearchChange(() => void refreshSidebar().catch(() => {}));
  }, [refreshSidebar]);

  /** Puts the experiment bar on an experiment, with its command and its newest run; null starts a new one on the next run. */
  const chooseExperiment = useCallback(
    async (id: string | null) => {
      try {
        const drafts = (await service.experiments(projectId)).items;
        const chosen = drafts.find((item) => item.id === id) ?? null;
        setExperiment(chosen);
        setCommand(chosen?.command ?? "");
        remember({ experimentId: chosen?.id });
        const newest = chosen ? (await service.runs(projectId)).items.filter((item) => item.experimentId === chosen.id).at(-1) : undefined;
        setSelectedOffset(null);
        if (newest) await refreshRun(newest.id);
        else {
          setRun(null);
          setSamples([]);
        }
      } catch (error) {
        notify(messageOf(error));
      }
    },
    [notify, projectId, refreshRun, remember],
  );

  // Another screen may ask for a file to be opened here, or for an experiment to be the one the bar runs.
  useEffect(
    () =>
      service.onOpen((target) => {
        if (target.kind === "file") void openFile(target.path);
        if (target.kind === "experiment") void chooseExperiment(target.experimentId);
      }),
    [chooseExperiment, openFile],
  );

  // Reopens what was open: records come from the project, the rest from this device.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const drafts = (await service.experiments(projectId)).items;
        const chosen = drafts.find((item) => item.id === session.current.experimentId) ?? drafts.at(-1) ?? null;
        if (!live) return;
        setExperiment(chosen);
        setCommand(chosen?.command ?? "");
        await refreshFindings();
        const runs = (await service.runs(projectId)).items;
        const last = runs.find((item) => item.id === session.current.runId) ?? runs.at(-1);
        if (last && live) await refreshRun(last.id);
        if (session.current.file && live) await openFile(session.current.file);
      } catch (error) {
        if (live) notify(messageOf(error));
      }
    })();
    return () => {
      live = false;
    };
    // Only when the workspace opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every change to the records says to read a live run again, with a slow poll in case the stream drops.
  const activeRunId = run && isRunActive(run.status) ? run.id : null;
  useEffect(() => {
    if (!activeRunId) return undefined;
    const refresh = () => void refreshRun(activeRunId).catch(() => {});
    const stopListening = desktop.live.onResearchChange(refresh);
    const timer = window.setInterval(refresh, 2000);
    return () => {
      stopListening();
      window.clearInterval(timer);
    };
  }, [activeRunId, refreshRun]);

  // A turn of the assistant may have changed the open file: follow it, unless there is unsaved text to protect.
  useEffect(() => {
    if (!open || dirty) return undefined;
    const { path, revision } = open;
    return desktop.live.onChange(() => {
      service
        .readSource(projectId, path)
        .then((view) => {
          if ((view.kind === "file" || view.kind === "document") && view.revision !== revision) void openFile(path);
        })
        .catch(() => {});
    });
  }, [dirty, open, openFile, projectId]);

  const save = useCallback(
    async (force = false) => {
      if (!open || open.document) return true;
      if (isNotebookPath(open.path) && new TextEncoder().encode(content.current).length > NOTEBOOK_SIZE_LIMIT) {
        notify(t("This notebook is over 8 MB with its outputs, so it would not open again. Clear its outputs, then save."));
        return false;
      }
      setSaving(true);
      try {
        let revision = open.revision;
        if (force) {
          const latest = await service.readSource(projectId, open.path);
          revision = latest.kind === "file" ? latest.revision : null;
        }
        const writing = content.current;
        const saved = await service.writeSource(projectId, open.path, writing, revision);
        languageServices.current?.saved(open.path, writing);
        setOpen((current) => (current ? { ...current, revision: saved.revision } : current));
        setDirty(false);
        setConflict(false);
        remember({ draft: undefined });
        return true;
      } catch (error) {
        if (isConflict(error)) setConflict(true);
        else notify(messageOf(error));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [notify, open, projectId, remember],
  );

  const handleEdit = useCallback(
    (next: string) => {
      content.current = next;
      setDirty(true);
      if (open) remember({ draft: next.length <= LARGEST_DRAFT ? { file: open.path, content: next, revision: open.revision } : undefined });
    },
    [open, remember],
  );

  /** Closes a file's tab, asking first when it holds unsaved text; the next tab, or the one before, takes its place. */
  async function closeTab(path: string) {
    const active = open?.path === path;
    if ((active ? dirty : unsaved.current.has(path)) && !(await askToConfirm(t("{file} has changes that are not saved. Close it and lose them?", { file: path })))) return;
    unsaved.current.delete(path);
    languageServices.current?.forget(path);
    const next = tabAfterClosing(tabs, path);
    setTabs((current) => current.filter((item) => item !== path));
    if (!active) return;
    if (next) {
      // Nothing of the closed file is kept: its text was given up above.
      setDirty(false);
      editing.current = { open: null, dirty: false };
      await openFile(next);
      return;
    }
    content.current = "";
    setDirty(false);
    setConflict(false);
    setSelection(null);
    setOpen(null);
    remember({ file: undefined, draft: undefined });
  }

  async function startRun() {
    if (!command.trim()) {
      notify(t("Enter the command that runs this experiment."));
      return;
    }
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      const code = open ? [open.path] : [];
      // Another screen may have changed the draft since this one read it.
      const latest = (await service.experiments(projectId)).items;
      let draft = latest.find((item) => item.id === experiment?.id) ?? experiment;
      if (!draft) {
        draft = await service.createExperiment(projectId, { title: t("Experiment in {project}", { project: props.project.name }), command, inputs: { code } });
      } else if (draft.command !== command || !draft.inputs?.code?.length) {
        draft = await service.updateExperiment(projectId, draft, { command, inputs: { ...draft.inputs, code: draft.inputs?.code?.length ? draft.inputs.code : code } });
      }
      setExperiment(draft);
      remember({ experimentId: draft.id });
      const version = await service.freeze(projectId, draft.id);
      const started = await service.startRun(projectId, version.id, crypto.randomUUID());
      void refreshSidebar().catch(() => {});
      remember({ runId: started.id });
      setSelectedOffset(null);
      setRun(started);
      setSamples([]);
      setPanel(PANEL.run);
      await refreshRun(started.id);
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setBusy(false);
    }
  }



  async function moreSamples() {
    if (!run || nextCursor === null) return;
    try {
      const page = await service.samples(projectId, run.id, nextCursor);
      setSamples((current) => [...current, ...page.items]);
      setNextCursor(page.next);
    } catch (error) {
      notify(messageOf(error));
    }
  }

  async function addFinding() {
    if (!findingText.trim()) return;
    try {
      await service.addFinding(projectId, findingText.trim(), findingKind, run ? [run.id] : []);
      setFindingText("");
      await refreshFindings();
    } catch (error) {
      notify(messageOf(error));
    }
  }

  const selected = samples.find((item) => item.offset === selectedOffset) ?? null;
  useEffect(() => {
    onFocus({ file: open?.path ?? null, selection, run, errorOutput, sample: selected });
  }, [errorOutput, onFocus, open?.path, run, selected, selection]);

  const rows = treeRows(tree);
  const focused = Math.min(focusedRow, Math.max(rows.length - 1, 0));
  const toggleFolder = (path: string, opened?: boolean) => setTree((current) => toggled(current, path, opened));
  const focusRow = (index: number) => {
    setFocusedRow(index);
    treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]")[index]?.focus();
  };
  const onTreeKey = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "F2" && rows[focused]?.entry.kind === "file") {
      event.preventDefault(); beginRename(rows[focused].entry.path); return;
    }
    const move = keyMove(rows, focused, event.key);
    if (move.kind === "none") return;
    event.preventDefault();
    if (move.kind === "focus") focusRow(move.index);
    else if (move.kind === "toggle") toggleFolder(move.path, move.open);
    else void openFile(move.path);
  };
  const fileTree = (
    <div ref={treeRef} role="tree" aria-label={t("Files")} className="flex flex-col" onKeyDown={onTreeKey}>
      {rows.map((row, index) => {
        const isFolder = row.entry.kind === "directory";
        const current = open?.path === row.entry.path;
        return (
          <div
            key={row.entry.path}
            role="treeitem"
            aria-level={row.depth}
            aria-expanded={isFolder ? row.expanded : undefined}
            aria-selected={current}
            tabIndex={index === focused ? 0 : -1}
            title={row.entry.path}
            className={classes(TREE_ROW, current && "bg-muted text-foreground", row.generated && "opacity-55")}
            style={{ paddingLeft: 6 + (row.depth - 1) * 12 }}
            onFocus={() => { setFocusedRow(index); setSelectedPath(row.entry.path); }}
            onClick={() => {
              setFocusedRow(index);
              setSelectedPath(row.entry.path);
              if (isFolder) toggleFolder(row.entry.path);
              else void openFile(row.entry.path);
            }}
          >
            <span aria-hidden="true" className="w-3 flex-none text-center text-muted-foreground">
              {isFolder ? (row.expanded ? "▾" : "▸") : ""}
            </span>
            <span className="min-w-0 truncate">{row.entry.name}</span>
            {!isFolder ? <button type="button" className="ml-auto flex-none cursor-pointer rounded px-1 text-muted-foreground opacity-0 hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100" aria-label={t("Rename {file}", { file: row.entry.path })} title={t("Rename file")} disabled={saving} onClick={(event) => { event.stopPropagation(); beginRename(row.entry.path); }}>✎</button> : null}
            {row.loading ? <span className="ml-auto flex-none text-[10px] text-muted-foreground">{t("Loading…")}</span> : null}
          </div>
        );
      })}
    </div>
  );
  const files = (
    <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-auto bg-panel px-2 py-2.5 [&>*]:shrink-0" aria-label={t("Project")} data-tour="workspace-files">
      {sidebar.questions.length ? (
        <section className="mb-3 flex flex-col gap-0.5">
          <div className="mb-1 flex items-baseline justify-between gap-2 px-1.5 text-[11px] font-semibold text-muted-foreground">
            <span>{t("Questions")}</span>
            <span className="font-normal tabular-nums">{sidebar.questions.length}</span>
          </div>
          {[...sidebar.questions].reverse().slice(0, 3).map((item) => (
            <button type="button" key={item.id} className={QUESTION_ENTRY} title={item.title} onClick={() => props.go("Home")}>
              <span className="w-0.5 flex-none self-stretch rounded-full bg-muted-foreground/30 group-hover:bg-primary" aria-hidden="true" />
              <span className="line-clamp-3 min-w-0 text-[12px] leading-normal [overflow-wrap:anywhere]">{item.title}</span>
            </button>
          ))}
          {sidebar.questions.length > 3 ? (
            <button type="button" className="cursor-pointer self-start border-0 bg-transparent px-1.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => props.go("Home")}>
              {t("All {count} questions", { count: sidebar.questions.length })}
            </button>
          ) : null}
        </section>
      ) : null}
      <section className="mb-3 flex flex-col gap-px">
        <div className="mb-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]">{t("Models")}</div>
        <Button variant="ghost" size="small" className={ENTRY} onClick={() => props.go("Lineage")}>
          {sidebar.models.length === 1 ? t("Lineage · 1 node") : t("Lineage · {count} nodes", { count: sidebar.models.length })}
        </Button>
      </section>
      <section className="mb-3 flex flex-col gap-1">
        <div className="mb-0.5 flex items-center justify-between gap-1 px-1.5 text-[11px] font-semibold text-muted-foreground">
          <span>{t("Files")}</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="small" className="h-6 px-1.5" title={t("New file")} aria-label={t("New file")} disabled={saving} onClick={() => {
              const selected = rows.find((row) => row.entry.path === selectedPath)?.entry;
              const folder = selected?.kind === "directory" ? selected.path : parentOf(selectedPath ?? open?.path ?? "");
              setFileAction({ kind: "create", path: folder === "." ? "" : `${folder}/` });
            }}>＋</Button>
            <Button variant="ghost" size="small" className="h-6 px-1.5" title={t("Rename file")} aria-label={t("Rename file")} disabled={saving || !selectedPath || rows.some((row) => row.entry.path === selectedPath && row.entry.kind === "directory")} onClick={() => { if (selectedPath) beginRename(selectedPath); }}>✎</Button>
          </div>
        </div>
        <Input className="h-7 text-xs" value={fileQuery} placeholder={t("Find a file")} aria-label={t("Find a file")} onChange={(event) => setFileQuery(event.target.value)} />
        {foundFiles ? (
          foundFiles.length ? (
            <div className="flex flex-col gap-px" role="list" aria-label={t("Files found")}>
              {foundFiles.map((path) => (
                <button type="button" role="listitem" key={path} title={path} className={classes(TREE_ROW, open?.path === path && "bg-muted text-foreground")} onClick={() => void openFile(path)}>
                  <span className="min-w-0 truncate">{path}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-1.5 text-xs text-muted-foreground">{t("No file matches.")}</div>
          )
        ) : (
          fileTree
        )}
      </section>
      {sidebar.drafts.length ? (
        <section className="mb-3 flex flex-col gap-px">
          <div className="mb-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]">{t("Experiments")}</div>
          {[...sidebar.drafts].reverse().slice(0, 4).map((item) => (
            <Button variant="ghost" size="small" key={item.id} className={classes(ENTRY, item.id === experiment?.id && "bg-muted")} title={item.title} onClick={() => { service.open(projectId, { kind: "experiment", experimentId: item.id }); props.go("Experiments"); }}>
              {item.title}
            </Button>
          ))}
        </section>
      ) : null}
    </nav>
  );

  // The bar speaks of the run of the experiment it is on, and of that run's version.
  const shown = runOfExperiment(run, experiment?.id ?? null);
  const shownVersion = shown ? sidebar.versions.find((item) => item.id === shown.versionId) : undefined;
  const runVersion = run ? sidebar.versions.find((item) => item.id === run.versionId) : undefined;

  const lower = (
    <div className="flex min-h-0 flex-1 flex-col bg-panel" data-tour="workspace-panels">
      {/* One row: the results' tabs, then the experiment bar beside them (which experiment, its command, the button that
          freezes and runs it), which wraps under the tabs when the pane is narrow. */}
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-2 py-1.5">
        <Tabs label={t("Results")} tabs={PANELS} current={panel} onChoose={setPanel} />
        <div className="ml-auto flex min-w-0 flex-[1_1_300px] items-center justify-end gap-1.5" role="group" aria-label={t("Run an experiment")}>
          <Choice
            ariaLabel={t("Experiment")}
            className="w-auto min-w-0 flex-[0_1_auto]"
            triggerClassName="h-7 w-32 max-w-full"
            value={experiment?.id ?? NEW_EXPERIMENT}
            options={[...[...sidebar.drafts].reverse().map((item) => ({ value: item.id, label: item.title })), { value: NEW_EXPERIMENT, label: t("New experiment") }]}
            onChange={(id) => void chooseExperiment(id === NEW_EXPERIMENT ? null : id)}
          />
          {shown && isRunActive(shown.status) ? (
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2" aria-live="polite">
              {/* The samples so far are in the Run tab; the bar keeps to what fits beside the tabs. */}
              <span className="flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap" title={command}>
                <span className={classes("size-2 flex-none rounded-full", shown.status === "paused" ? "bg-wait" : "animate-pulse bg-good")} aria-hidden="true" />
                {runStatusLabel(shown.status)}
                {shownVersion ? <span className="text-muted-foreground">· v{shownVersion.number}</span> : null}
              </span>
              <RunControls compact projectId={projectId} run={shown} changed={() => void refreshRun(shown.id)} notify={notify} />
            </div>
          ) : (
            <>
              <label className="flex h-7 min-w-[100px] flex-1 items-center gap-1.5 rounded-md border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring/40">
                <span aria-hidden="true" className="font-mono text-xs text-muted-foreground select-none">$</span>
                <input className="h-full min-w-0 flex-1 border-0 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground" aria-label={t("Command that runs the experiment")} data-tour="workspace-command" placeholder="python probe.py" title={command} value={command} spellCheck={false} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !busy) void startRun(); }} />
              </label>
              <Button size="small" className="flex-none" data-tour="workspace-run" disabled={busy} title={t("Freezes the code and settings as a version (the last one, when nothing changed) and runs it once.")} onClick={() => void startRun()}>
                <span aria-hidden="true">▶</span> {busy ? t("Starting…") : t("Freeze and run")}
              </Button>
            </>
          )}
          {experiment ? (
            <Button variant="ghost" size="small" className="flex-none px-1.5 text-muted-foreground" title={t("Open in Experiments")} aria-label={t("Open in Experiments")} onClick={() => { service.open(projectId, { kind: "experiment", experimentId: experiment.id }); props.go("Experiments"); }}>
              <span aria-hidden="true">↗</span>
            </Button>
          ) : null}
        </div>
      </div>
      {/* The samples tab scrolls its list and its preview apart, so it fills the panel instead of scrolling it. */}
      <div className={classes("min-h-0 flex-1", panel === PANEL.samples || panel === PANEL.terminal ? "overflow-hidden" : "overflow-auto px-3 py-2.5")} role="tabpanel" aria-label={panel}>
        {panel === PANEL.run ? (
          run ? (
            <div className="flex flex-col gap-1">
              <div className="font-semibold">
                {runStatusLabel(run.status)}
                {runVersion ? <span className="font-normal text-muted-foreground"> · v{runVersion.number}</span> : null}
              </div>
              <div className={MUTED}>
                {t("{count} samples", { count: run.samples ?? samples.length })}
                {run.infrastructureErrors ? t(", {count} infrastructure errors", { count: run.infrastructureErrors }) : ""}
                {run.exitCode !== undefined && run.exitCode !== null ? t(", exit code {code}", { code: run.exitCode }) : ""}
              </div>
              {run.inputsChanged?.length ? <div className={WARNING}>{t("Changed during the run: {inputs}", { inputs: run.inputsChanged.join(", ") })}</div> : null}
              {run.sealIntact === false ? <div className={WARNING}>{t("The samples changed after the run was sealed. They no longer stand for its results.")}</div> : null}
              {run.warnings?.map((warning) => <div key={warning} className={WARNING}>{warning}</div>)}
              {run.status === "interrupted" && run.process === "unconfirmed" ? <div className={WARNING}>{t("Its process could not be confirmed, so it was not ended.")}</div> : null}
              {run.error ? <div className={WARNING}>{run.error}</div> : null}
              {run.problems?.slice(0, 5).map((item) => (
                <div key={item.line} className={WARNING}>
                  {t("Line {line}: {reason}", { line: item.line, reason: item.reason })}
                </div>
              ))}
              {errorOutput ? <pre className={classes(OUTPUT_TEXT, "text-destructive")}>{errorOutput}</pre> : null}
            </div>
          ) : (
            <p className={MUTED}>{t("Enter a command above and run it. What it writes appears here.")}</p>
          )
        ) : null}
        {panel === PANEL.samples ? (
          <div className="flex h-full min-h-0">
            <div
              className="flex w-[230px] max-w-[45%] min-w-[150px] flex-none flex-col gap-px overflow-y-auto border-r border-border px-1.5 py-2"
              role="listbox"
              aria-label={t("Samples")}
              tabIndex={0}
              onKeyDown={(event) => {
                // Up and down go through the samples, as in a file list.
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const at = samples.findIndex((item) => item.offset === selectedOffset);
                const next = samples[Math.min(samples.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))];
                if (next) setSelectedOffset(next.offset);
              }}
            >
              <div className="px-2 pb-1 text-[11px] text-muted-foreground">{t("{count} samples", { count: run?.samples ?? samples.length })}</div>
              {samples.map((item) => {
                const id = item.sample ? sampleIdParts(item.sample.sampleId) : null;
                const chosen = item.offset === selectedOffset;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={chosen}
                    tabIndex={-1}
                    key={item.offset}
                    ref={chosen ? (element) => element?.scrollIntoView({ block: "nearest" }) : undefined}
                    className={classes(SAMPLE_ENTRY, chosen ? "bg-muted text-foreground before:bg-primary" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
                    title={item.sample?.sampleId}
                    onClick={() => setSelectedOffset(item.offset)}
                  >
                    {item.sample?.error || !item.sample ? <span className="size-1.5 flex-none rounded-full bg-wait" aria-hidden="true" /> : null}
                    {id ? (
                      <span className="flex min-w-0 flex-1 font-mono whitespace-nowrap">
                        <span className="min-w-0 flex-[0_1_auto] truncate">{id.start}</span>
                        <span className="flex-none">{id.end}</span>
                      </span>
                    ) : <span className={classes(WARNING, "truncate")}>{t("Problem at byte {offset}", { offset: item.offset })}</span>}
                    {item.sample?.error ? <span className="sr-only">{t("{kind} error", { kind: item.sample.error.kind })}</span> : null}
                  </button>
                );
              })}
              {nextCursor !== null ? (
                <Button variant="ghost" size="small" className="self-start text-info" onClick={() => void moreSamples()}>
                  {t("More")}
                </Button>
              ) : null}
              {samples.length === 0 ? <p className={classes(MUTED, "px-2")}>{t("No samples yet.")}</p> : null}
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
              {selected ? <SampleDetail item={selected} /> : samples.length ? <p className={MUTED}>{t("Choose a sample to see it here.")}</p> : null}
            </div>
          </div>
        ) : null}
        {panel === PANEL.findings ? (
          <div className="flex flex-col gap-2">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void addFinding();
              }}
            >
              <Choice label={t("Kind")} className="flex-[0_1_150px]" value={findingKind} options={(Object.keys(FINDING_LABELS) as FindingKind[]).map((kind) => ({ value: kind, label: FINDING_LABELS[kind] }))} onChange={(next) => setFindingKind(next as FindingKind)} />
              <Field label={t("What you understood")} className="flex-[1_1_260px]">
                <Textarea className="resize-y" rows={2} value={findingText} onChange={(event) => setFindingText(event.target.value)} />
              </Field>
              <Button type="submit" variant="outline" disabled={!findingText.trim()}>
                {t("Save finding")}
              </Button>
            </form>
            {[...findings].reverse().map((finding) => (
              <Card key={finding.id} className="gap-1 px-3.5 py-3">
                <div className={MUTED}>
                  {FINDING_LABELS[finding.kind]}
                  {byAssistant(finding) ? ` · ${t("by the assistant")}` : ""}
                  {finding.runIds?.length ? ` · ${finding.runIds[0]}` : ""}
                </div>
                <div>{finding.text}</div>
              </Card>
            ))}
          </div>
        ) : null}
        {panel === PANEL.resources ? (run ? <Resources key={run.id} projectId={projectId} run={run} notify={notify} /> : <p className={MUTED}>{t("Run the experiment to see what it costs.")}</p>) : null}
        {panel === PANEL.artifacts ? <Artifacts key={run?.id ?? projectId} projectId={projectId} runId={run?.id} notify={notify} go={props.go} /> : null}
        {panel === PANEL.activations ? (
          run && selected?.sample ? (
            <LookInside key={`${run.id}:${selected.sample.sampleId}`} projectId={projectId} runId={run.id} sampleId={selected.sample.sampleId} modelId={selected.sample.modelId ?? null} models={sidebar.models} notify={notify} />
          ) : (
            <p className={MUTED}>{t("Choose a sample under Samples, then look inside it here.")}</p>
          )
        ) : null}
        <div hidden={panel !== PANEL.terminal} className="h-full">
          <Terminal folder={props.project.path} active={panel === PANEL.terminal} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {fileAction ? <FileActionDialog key={`${fileAction.kind}:${fileAction.path}`} action={fileAction} onSubmit={applyFileAction} onClose={() => setFileAction(null)} /> : null}
      <h1 className="sr-only">{open ? t("Workspace: {path}", { path: open.path }) : t("Workspace")}</h1>
      <Split id="files" side="left" size={210} minimum={140} label={t("Files")} pane={files}>
        {/* The centre's tabs: each open file, then the assistant's browser; the saved state of the file shown on the right. */}
        <div className="flex min-h-8 flex-none items-stretch border-b border-border">
          <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label={t("Open files")}>
            {tabs.map((path) => {
              const current = centre === "editor" && open?.path === path;
              const changed = current ? dirty : unsaved.current.has(path);
              return (
                <div key={path} className={classes("group flex max-w-[200px] min-w-0 flex-none items-center border-r border-border text-xs", current ? "bg-background text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
                  <button type="button" role="tab" aria-selected={current} title={path} className="flex min-w-0 cursor-pointer items-center gap-1.5 self-stretch border-0 bg-transparent py-1 pr-1 pl-2.5 font-mono text-inherit" onClick={() => (current ? undefined : void openFile(path))}>
                    <span className="truncate">{path.split("/").pop()}</span>
                    {changed ? <span className="size-1.5 flex-none rounded-full bg-wait" aria-label={t("Not saved")} /> : null}
                  </button>
                  <button type="button" className="mr-1 flex size-4 flex-none cursor-pointer items-center justify-center rounded border-0 bg-transparent text-[11px] text-muted-foreground opacity-60 group-hover:opacity-100 hover:bg-muted hover:text-foreground" aria-label={t("Close {file}", { file: path })} onClick={() => void closeTab(path)}>
                    ×
                  </button>
                </div>
              );
            })}
            {browserTab ? (
              <div className={classes("group flex flex-none items-center border-r border-border text-xs", centre === "browser" ? "bg-background text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
                <button type="button" role="tab" aria-selected={centre === "browser"} title={browser.frame?.url ?? browser.state?.url} className="flex cursor-pointer items-center gap-1.5 self-stretch border-0 bg-transparent py-1 pr-1 pl-2.5 text-inherit" onClick={() => setCentre("browser")}>
                  {browsing ? <span className="size-1.5 flex-none animate-pulse rounded-full bg-good" aria-hidden="true" /> : null}
                  {t("Browser")}
                  {browserHost(browser.frame?.url ?? browser.state?.url) ? <span className="max-w-[120px] truncate text-muted-foreground">· {browserHost(browser.frame?.url ?? browser.state?.url)}</span> : null}
                </button>
                <button type="button" className="mr-1 flex size-4 flex-none cursor-pointer items-center justify-center rounded border-0 bg-transparent text-[11px] text-muted-foreground opacity-60 group-hover:opacity-100 hover:bg-muted hover:text-foreground" aria-label={t("Close the browser tab")} title={browsing ? t("Hides the tab; the assistant keeps browsing. Browser, on the right, shows it again.") : undefined} onClick={() => { setBrowserTab(false); setCentre("editor"); }}>
                  ×
                </button>
              </div>
            ) : null}
            {!tabs.length && !browserTab ? <span className="self-center px-2.5 text-xs text-muted-foreground">{t("No file open")}</span> : null}
          </div>
          <div className="flex flex-none items-center gap-2 px-2.5">
            {centre === "editor" && open ? <span className={MUTED}>{open.document ? t("Read only") : saving ? t("Saving…") : dirty ? t("Not saved") : t("Saved")}</span> : null}
            {!browserTab ? (
              <button type="button" className="flex cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent px-1 text-[11px] text-muted-foreground hover:text-foreground" title={t("Show the assistant's browser here")} onClick={() => { setBrowserTab(true); setCentre("browser"); }}>
                {browsing ? <span className="size-1.5 animate-pulse rounded-full bg-good" aria-hidden="true" /> : null}
                {t("Browser")}
              </button>
            ) : null}
          </div>
        </div>
        {conflict && open ? (
          <Notice tone="wait" role="alert" className="flex flex-wrap items-center gap-2.5 rounded-none border-x-0 whitespace-normal">
            {t("This file changed since you opened it.")}
            <Button variant="ghost" size="small" className="text-info" onClick={() => void openFile(open.path)}>
              {t("Reload theirs")}
            </Button>
            <Button variant="ghost" size="small" className="text-info" onClick={() => void save(true)}>
              {t("Keep mine")}
            </Button>
          </Notice>
        ) : null}
        <Split id="lower" side="bottom" size={220} minimum={100} label={t("Results")} pane={lower}>
          {centre === "browser" ? <AgentBrowserView state={browser.state} frame={browser.frame} back={{ label: t("Back to the editor"), onClick: () => setCentre("editor") }} /> : null}
          {/* The editor stays mounted behind the browser, so its text, place and undo history are kept. */}
          <div className={classes("min-h-0 flex-1 flex-col", centre === "editor" ? "flex" : "hidden")}>
          {open?.document ? (
            <DocumentView key={`${open.path}:${open.generation}`} path={open.path} mime={open.document.mime} data={open.document.data} />
          ) : open && isNotebookPath(open.path) ? (
            <NotebookEditor
              key={open.path}
              projectId={projectId}
              path={open.path}
              generation={open.generation}
              initialContent={open.initial}
              onChange={handleEdit}
              onSave={() => void save()}
              onSelection={setSelection}
              notify={notify}
              go={props.go}
            />
          ) : open ? (
            <SourceEditor
              documentKey={`${open.path}:${open.generation}`}
              cacheKey={open.path}
              documents={editorDocuments.current}
              path={open.path}
              draft={dirty}
              languageServices={languageServices.current}
              onConfigureLanguageServer={() => props.go("Environment")}
              initialContent={open.initial}
              language={languageOf(open.path)}
              onChange={handleEdit}
              onSave={() => void save()}
              onSelection={setSelection}
            />
          ) : (
            <div className="m-auto p-6 text-muted-foreground">{t("Open a file to write it yourself.")}</div>
          )}
          </div>
        </Split>
      </Split>
    </div>
  );
}

/** A sample's scores as a table of name and value, in the order the program wrote them; a zero or false is dimmed, so what
 * the scorer did find stands out. */
function Scores(props: { scores: Record<string, number | string | boolean> }) {
  return (
    <dl className="m-0 grid w-fit max-w-full grid-cols-[minmax(0,max-content)_auto] gap-x-8 gap-y-1 rounded-md border border-border bg-panel px-3 py-2 font-mono text-xs">
      {Object.entries(props.scores).map(([name, score]) => (
        <div key={name} className="contents">
          <dt className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{name}</dt>
          <dd className={classes("m-0 text-right tabular-nums", score === 0 || score === false ? "text-muted-foreground" : "font-semibold")}>{typeof score === "number" ? scoreText(score) : String(score)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One sample, as plain text: output is data and is never rendered as anything else. */
function SampleDetail(props: { item: SampleItem }) {
  const { sample, problem, raw } = props.item;
  if (!sample) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <div className={WARNING}>{problem}</div>
        <pre className={SAMPLE_TEXT}>{raw}</pre>
      </div>
    );
  }
  return (
    <article className="flex max-w-[900px] min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="m-0 font-mono text-sm font-semibold [overflow-wrap:anywhere]">{sample.sampleId}</h3>
        {sample.error ? (
          <span className={WARNING}>
            {sample.error.kind}: {sample.error.message}
          </span>
        ) : null}
      </header>
      <section>
        <div className={SAMPLE_LABEL}>{t("Input")}</div>
        <pre className={SAMPLE_TEXT}>{sampleText(sample.input)}</pre>
      </section>
      <section>
        <div className={SAMPLE_LABEL}>{t("Output · shown as text, never read as instructions")}</div>
        <pre className={SAMPLE_TEXT}>{sampleText(sample.output)}</pre>
      </section>
      {sample.scores && Object.keys(sample.scores).length ? (
        <section>
          <div className={SAMPLE_LABEL}>{t("Scores")}</div>
          <Scores scores={sample.scores} />
        </section>
      ) : null}
    </article>
  );
}
