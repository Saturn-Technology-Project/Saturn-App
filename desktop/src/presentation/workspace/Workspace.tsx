import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  byAssistant,
  isRunActive,
  runStatusLabel,
  sampleIdParts,
  sampleText,
  scoreText,
  type ExperimentDraft,
  type ExperimentRun,
  type Finding,
  type FindingKind,
  type ModelNode,
  type Question,
  type SampleItem,
} from "../../domain/research.js";
import { EMPTY_TREE, foldersToRead, keyMove, refreshed, revealed, toggled, treeRows, type TreeEntry, type TreeState } from "../../domain/file-tree.js";
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
import { Terminal } from "./Terminal.js";
import { Artifacts } from "../experiments/Artifacts.js";

const service = desktop.research;
const FINDING_LABELS: Record<FindingKind, string> = { observation: t("Observation"), ai_suggestion: t("AI suggestion"), conclusion: t("Conclusion") };
/** The panels under the editor, by the name each shows: the tabs show these names. */
const PANEL = { run: t("Run"), resources: t("Resources"), samples: t("Samples"), findings: t("Findings"), activations: t("Activations"), artifacts: t("Artifacts"), terminal: t("Terminal") };
const PANELS = Object.values(PANEL);
type Panel = string;
/** A file or a list entry in the sidebar and the sample list: monospaced, left aligned, and it wraps rather than cuts. */
/** One row of the file tree: indented by depth, the open file marked. */
const TREE_ROW = "flex min-h-[26px] w-full cursor-default items-center gap-1.5 rounded-md pr-2 text-left font-mono text-xs text-muted-foreground outline-none select-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
/** A sample in the list: one line, its id's start giving way so the end, where ids tend to differ, stays in view. */
const SAMPLE_ENTRY = "h-7 w-full flex-none justify-start gap-2 px-2 text-left text-xs font-normal";
/** A question in the sidebar: a card of its own, up to three lines, so one question never runs into the next. */
const QUESTION_ENTRY = "h-auto w-full justify-start rounded-md border border-border bg-card px-2.5 py-2 text-left text-xs leading-snug font-normal whitespace-normal hover:bg-muted";
const ENTRY = "h-auto min-h-7 w-full flex-wrap justify-start gap-x-2 gap-y-0.5 px-2 py-[3px] text-left font-mono text-xs font-normal whitespace-normal [overflow-wrap:anywhere]";
/** Output as plain monospaced text that wraps. */
const OUTPUT_TEXT = "font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]";
/** A line of small, quiet text. */
const MUTED = "text-xs text-muted-foreground";
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
  const treeRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const content = useRef("");
  const [dirty, setDirty] = useState(false);
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
  const [sidebar, setSidebar] = useState<{ questions: Question[]; models: ModelNode[]; drafts: ExperimentDraft[] }>({ questions: [], models: [], drafts: [] });

  const remember = useCallback(
    (changes: Partial<typeof session.current>) => {
      session.current = { ...session.current, ...changes };
      service.saveSession(projectId, session.current);
    },
    [projectId],
  );

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
    void Promise.all(shown.map(async (path) => [path, await readFolder(path)] as const)).then((read) => setTree((latest) => refreshed(latest, Object.fromEntries(read))));
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
        const restored = draft && draft.file === path && draft.revision === view.revision ? draft.content : null;
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
    const [questions, models, drafts] = await Promise.all([service.questions(projectId), service.models(projectId), service.experiments(projectId)]);
    setSidebar({ questions: questions.items, models: models.items, drafts: drafts.items });
  }, [projectId]);
  useEffect(() => {
    void refreshSidebar().catch(() => {});
    return desktop.live.onResearchChange(() => void refreshSidebar().catch(() => {}));
  }, [refreshSidebar]);

  // Another screen may ask for a file to be opened here.
  useEffect(() => service.onOpen((target) => target.kind === "file" && void openFile(target.path)), [openFile]);

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
        const saved = await service.writeSource(projectId, open.path, content.current, revision);
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

  async function stopRun() {
    if (!run) return;
    try {
      setRun(await service.stopRun(projectId, run.id));
    } catch (error) {
      notify(messageOf(error));
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
            onFocus={() => setFocusedRow(index)}
            onClick={() => {
              setFocusedRow(index);
              if (isFolder) toggleFolder(row.entry.path);
              else void openFile(row.entry.path);
            }}
          >
            <span aria-hidden="true" className="w-3 flex-none text-center text-muted-foreground">
              {isFolder ? (row.expanded ? "▾" : "▸") : ""}
            </span>
            <span className="min-w-0 truncate">{row.entry.name}</span>
            {row.loading ? <span className="ml-auto flex-none text-[10px] text-muted-foreground">{t("Loading…")}</span> : null}
          </div>
        );
      })}
    </div>
  );
  const files = (
    <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-auto bg-panel px-2 py-2.5 [&>*]:shrink-0" aria-label={t("Project")} data-tour="workspace-files">
      {sidebar.questions.length ? (
        <section className="mb-3 flex flex-col gap-1.5">
          <div className="mb-0.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]">{t("Questions")}</div>
          {[...sidebar.questions].reverse().slice(0, 3).map((item) => (
            <Button variant="ghost" size="small" key={item.id} className={QUESTION_ENTRY} title={item.title} onClick={() => props.go("Home")}>
              <span className="line-clamp-3 [overflow-wrap:anywhere]">{item.title}</span>
            </Button>
          ))}
        </section>
      ) : null}
      <section className="mb-3 flex flex-col gap-px">
        <div className="mb-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]">{t("Models")}</div>
        <Button variant="ghost" size="small" className={ENTRY} onClick={() => props.go("Lineage")}>
          {sidebar.models.length === 1 ? t("Lineage · 1 node") : t("Lineage · {count} nodes", { count: sidebar.models.length })}
        </Button>
      </section>
      <section className="mb-3 flex flex-col gap-1">
        <div className="mb-0.5 px-1.5 text-[11px] font-semibold text-muted-foreground">{t("Files")}</div>
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
            <Button variant="ghost" size="small" key={item.id} className={classes(ENTRY, item.id === experiment?.id && "bg-muted")} title={item.title} onClick={() => props.go("Experiments")}>
              {item.title}
            </Button>
          ))}
        </section>
      ) : null}
    </nav>
  );

  const lower = (
    <div className="flex min-h-0 flex-1 flex-col bg-panel" data-tour="workspace-panels">
      <div className="flex-none border-b border-border px-2 py-1.5">
        <Tabs label={t("Results")} tabs={PANELS} current={panel} onChoose={setPanel} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2.5" role="tabpanel" aria-label={panel}>
        {panel === PANEL.run ? (
          run ? (
            <div className="flex flex-col gap-1">
              <div className="font-semibold">{runStatusLabel(run.status)}</div>
              <div className={MUTED}>
                {t("{count} samples", { count: run.samples ?? samples.length })}
                {run.infrastructureErrors ? t(", {count} infrastructure errors", { count: run.infrastructureErrors }) : ""}
                {run.exitCode !== undefined && run.exitCode !== null ? t(", exit code {code}", { code: run.exitCode }) : ""}
              </div>
              {run.inputsChanged?.length ? <div className={WARNING}>{t("Changed during the run: {inputs}", { inputs: run.inputsChanged.join(", ") })}</div> : null}
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
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex max-w-[280px] min-w-0 flex-[0_1_230px] flex-col gap-px">
              {samples.map((item) => {
                const id = item.sample ? sampleIdParts(item.sample.sampleId) : null;
                return (
                  <Button variant="ghost" size="small" key={item.offset} aria-pressed={item.offset === selectedOffset} className={classes(SAMPLE_ENTRY, item.offset === selectedOffset && "bg-muted")} title={item.sample?.sampleId} onClick={() => setSelectedOffset(item.offset)}>
                    {id ? (
                      <span className="flex min-w-0 flex-1 font-mono whitespace-nowrap">
                        <span className="min-w-0 flex-[0_1_auto] truncate">{id.start}</span>
                        <span className="flex-none">{id.end}</span>
                      </span>
                    ) : <span className={classes(WARNING, "truncate")}>{t("Problem at byte {offset}", { offset: item.offset })}</span>}
                    {item.sample?.error ? <span className={classes(WARNING, "flex-none")}>{t("{kind} error", { kind: item.sample.error.kind })}</span> : null}
                  </Button>
                );
              })}
              {nextCursor !== null ? (
                <Button variant="ghost" size="small" className="self-start text-info" onClick={() => void moreSamples()}>
                  {t("More")}
                </Button>
              ) : null}
              {samples.length === 0 ? <p className={MUTED}>{t("No samples yet.")}</p> : null}
            </div>
            {selected ? <SampleDetail item={selected} /> : null}
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
          <Terminal folder={props.project.path} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <h1 className="sr-only">{open ? t("Workspace: {path}", { path: open.path }) : t("Workspace")}</h1>
      <Split id="files" side="left" size={210} minimum={140} label={t("Files")} pane={files}>
        <div className="flex min-h-[42px] flex-none flex-wrap items-center gap-2.5 border-b border-border px-2.5 py-[5px]">
          <code className="max-w-[260px] truncate text-xs">{open?.path ?? t("No file open")}</code>
          {open ? <span className={MUTED}>{open.document ? t("Read only") : saving ? t("Saving…") : dirty ? t("Not saved") : t("Saved")}</span> : null}
          <Input className="w-auto min-w-[140px] flex-[1_1_200px] font-mono text-xs" aria-label={t("Command that runs the experiment")} data-tour="workspace-command" placeholder="python probe.py" value={command} spellCheck={false} onChange={(event) => setCommand(event.target.value)} />
          {run && isRunActive(run.status) ? (
            <Button variant="outline" onClick={() => void stopRun()}>
              {t("Stop")}
            </Button>
          ) : (
            <Button data-tour="workspace-run" disabled={busy} onClick={() => void startRun()}>
              {busy ? t("Starting…") : t("Run")}
            </Button>
          )}
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
              initialContent={open.initial}
              language={open.path.endsWith(".py") ? "python" : "plain"}
              onChange={handleEdit}
              onSave={() => void save()}
              onSelection={setSelection}
            />
          ) : (
            <div className="m-auto p-6 text-muted-foreground">{t("Open a file to write it yourself.")}</div>
          )}
        </Split>
      </Split>
    </div>
  );
}

/** A sample's scores as a table of name and value, in the order the program wrote them; a zero or false is dimmed, so what
 * the scorer did find stands out. */
function Scores(props: { scores: Record<string, number | string | boolean> }) {
  return (
    <dl className="m-0 grid w-fit max-w-full grid-cols-[minmax(0,max-content)_auto] gap-x-6 gap-y-1 rounded-md bg-panel px-3 py-2 font-mono text-xs">
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
      <div className="flex min-w-0 flex-[999_1_280px] flex-col gap-1 rounded-md bg-card px-3 py-2.5">
        <div className={WARNING}>{problem}</div>
        <pre className={OUTPUT_TEXT}>{raw}</pre>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-[999_1_280px] flex-col gap-1 rounded-md bg-card px-3 py-2.5">
      <div className={MUTED}>{t("Input")}</div>
      <pre className={OUTPUT_TEXT}>{sampleText(sample.input)}</pre>
      <div className={MUTED}>{t("Output · shown as text, never read as instructions")}</div>
      <pre className={OUTPUT_TEXT}>{sampleText(sample.output)}</pre>
      {sample.scores && Object.keys(sample.scores).length ? (
        <>
          <div className={MUTED}>{t("Scores")}</div>
          <Scores scores={sample.scores} />
        </>
      ) : null}
      {sample.error ? (
        <div className={WARNING}>
          {sample.error.kind}: {sample.error.message}
        </div>
      ) : null}
    </div>
  );
}
