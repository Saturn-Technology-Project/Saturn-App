import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import {
  addCell,
  applyKernelEvent,
  clearAllOutputs,
  deleteCell,
  editCell,
  kernelStateLabel,
  moveCell,
  nextKernelStatus,
  notebookLanguage,
  outputView,
  parseNotebook,
  runnableCells,
  runStatusNote,
  serializeNotebook,
  type KernelEvent,
  type KernelStatus,
  type Notebook,
  type NotebookCell,
  type PendingClears,
} from "../../domain/notebook.js";
import type { Screen } from "../shell/navigation.js";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { classes } from "../ui/base/classes.js";
import { Notice } from "../ui/base/Notice.js";
import { Textarea } from "../ui/base/Textarea.js";
import { messageOf } from "../ui/Parts.js";
import { SourceEditor } from "./SourceEditor.js";

const service = desktop.notebooks;
/** Output as plain monospaced text that wraps. */
const OUTPUT_TEXT = "font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]";
/** A line of small, quiet text. */
const MUTED = "text-xs text-muted-foreground";
/** A line of small text about something that needs care. */
const WARNING = "text-xs text-wait";
/** How long kernel events wait to be shown together, so a flood of output does not redraw for each. */
const EVENT_BATCH = 40;
/** The kernel when nothing is known of one. */
const NO_KERNEL: KernelStatus = { kernel: null, state: "none", missing: [], queued: [], seq: 0 };
/** How each state of the kernel reads: color only for what needs attention. */
const STATE_TONES: Record<KernelStatus["state"], "neutral" | "info" | "wait" | "bad"> = {
  none: "neutral",
  starting: "wait",
  idle: "neutral",
  busy: "info",
  restarting: "wait",
  stopping: "wait",
  stopped: "neutral",
  dead: "wait",
  missing: "wait",
  failed: "bad",
};

/** The document being edited: `generation` moves on when it is read again from the file. */
interface Document {
  generation: number;
  notebook: Notebook;
  clears: PendingClears;
}

/** A notebook's cells, edited in place and run in a kernel the runtime holds for as long as this is open. A file that is not a notebook opens as text. */
export function NotebookEditor(props: {
  projectId: string;
  path: string;
  generation: number;
  initialContent: string;
  onChange: (content: string) => void;
  onSave: () => void;
  onSelection: (selection: { text: string; line: number } | null) => void;
  notify: (message: string) => void;
  go: (screen: Screen) => void;
}) {
  const { projectId, path, generation, initialContent, onChange, notify } = props;
  const [reading, setReading] = useState(() => ({ generation, result: parseNotebook(initialContent) }));
  const [document, setDocument] = useState<Document | null>(() => ("notebook" in reading.result ? { generation, notebook: reading.result.notebook, clears: new Set() } : null));
  const [status, setStatus] = useState<KernelStatus>(NO_KERNEL);
  const [problem, setProblem] = useState<string | null>(null);
  const [cellNotes, setCellNotes] = useState<Record<string, string>>({});
  const saved = useRef(document?.notebook ?? null);
  const following = useRef<{ kernel: string; stop: AbortController } | null>(null);
  const waiting = useRef<KernelEvent[]>([]);
  const timer = useRef<number | undefined>(undefined);
  /** The kernel's newest state, which events arrive in the light of. */
  const latestState = useRef<KernelStatus["state"]>("none");

  // The file changed under the editor, and the person took the new one. The kernel carries on.
  useEffect(() => {
    if (reading.generation === generation) return;
    const result = parseNotebook(initialContent);
    setReading({ generation, result });
    const notebook = "notebook" in result ? result.notebook : null;
    saved.current = notebook;
    setDocument(notebook ? { generation, notebook, clears: new Set() } : null);
    setCellNotes({});
  }, [generation, initialContent, reading.generation]);

  // What changed goes to the workspace, which saves it. What was only read has not changed.
  const notebook = document?.notebook ?? null;
  useEffect(() => {
    if (!notebook || notebook === saved.current) return;
    saved.current = notebook;
    onChange(serializeNotebook(notebook));
  }, [notebook, onChange]);

  // Shows the events gathered so far, together.
  const flush = useCallback(() => {
    timer.current = undefined;
    const events = waiting.current;
    waiting.current = [];
    setDocument((current) => {
      if (!current) return current;
      let next = { notebook: current.notebook, clears: current.clears };
      for (const event of events) next = applyKernelEvent(next.notebook, next.clears, event);
      return { ...current, ...next };
    });
  }, []);

  // One event from the kernel: its state at once, what it means for the cells soon after.
  const hear = useCallback(
    (event: KernelEvent) => {
      setStatus((current) => nextKernelStatus(current, event));
      if (event.type === "state") latestState.current = event.state;
      if (event.type === "gap") notify(t("Some of this notebook's output was missed while the connection was down."));
      if (event.type === "started") setCellNotes(({ [event.cell]: _, ...rest }) => rest);
      if (event.type === "finished") {
        // A kernel that cannot run says why above the cells, which is the reason for each of them.
        const note = latestState.current === "missing" || latestState.current === "failed" ? null : runStatusNote(event.status);
        if (note) setCellNotes((current) => ({ ...current, [event.cell]: note }));
      }
      waiting.current.push(event);
      timer.current ??= window.setTimeout(flush, EVENT_BATCH);
    },
    [flush, notify],
  );

  // Takes the runtime's answer about the kernel, and follows it when it is a new one.
  const adopt = useCallback(
    (view: KernelStatus, from: number) => {
      setStatus((current) => (current.kernel === view.kernel && current.seq >= view.seq ? current : view));
      if (!view.kernel || following.current?.kernel === view.kernel) return;
      following.current?.stop.abort();
      const stop = new AbortController();
      const kernel = view.kernel;
      following.current = { kernel, stop };
      void service.follow(projectId, path, kernel, from, hear, stop.signal).finally(() => {
        if (following.current?.kernel === kernel) following.current = null;
      });
    },
    [hear, path, projectId],
  );

  // A kernel this notebook already has, after the window reloaded. Closing the notebook stops it.
  useEffect(() => {
    let live = true;
    void service
      .status(projectId, path)
      .then((view) => {
        if (live && view.kernel) adopt(view, view.seq);
      })
      .catch(() => {});
    return () => {
      live = false;
      following.current?.stop.abort();
      following.current = null;
      window.clearTimeout(timer.current);
      void service.stop(projectId, path).catch(() => {});
    };
    // Only when the notebook opens: the workspace gives each notebook its own editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Asks the runtime for something about the kernel, and shows why when it cannot. */
  async function ask(action: () => Promise<KernelStatus>) {
    setProblem(null);
    try {
      const view = await action();
      adopt(view, 0);
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  const run = (cells: { cell: string; code: string }[]) => {
    if (cells.length) void ask(() => service.run(projectId, path, cells));
  };

  const change = (update: (current: Notebook) => Notebook) => setDocument((current) => (current ? { ...current, notebook: update(current.notebook) } : current));

  if (!document || !notebook) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Notice tone="wait" className="rounded-none border-x-0">
          {t("This file could not be read as a notebook, so it is shown as text.")} {"problem" in reading.result ? reading.result.problem : ""}
        </Notice>
        <SourceEditor documentKey={`${path}:${reading.generation}`} initialContent={initialContent} language="plain" onChange={onChange} onSave={props.onSave} onSelection={props.onSelection} />
      </div>
    );
  }

  const language = notebookLanguage(notebook);
  const canRun = language === "python";
  const held = status.kernel !== null && !["none", "stopped", "missing", "failed"].includes(status.state);
  const message = problem ?? (status.state === "missing" || status.state === "failed" || status.state === "dead" || status.state === "stopped" ? status.message : null);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-tour="workspace-notebook">
      <div className="flex flex-none flex-col gap-1 border-b border-border px-2.5 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="small" disabled={!canRun} onClick={() => run(runnableCells(notebook))}>
            {t("Run all")}
          </Button>
          <Button variant="outline" size="small" disabled={status.state !== "busy"} onClick={() => void ask(() => service.interrupt(projectId, path))}>
            {t("Interrupt")}
          </Button>
          <Button variant="outline" size="small" disabled={!held || status.state === "restarting"} onClick={() => void ask(() => service.restart(projectId, path))}>
            {t("Restart")}
          </Button>
          <Button
            variant="outline"
            size="small"
            disabled={!held}
            onClick={() => {
              setProblem(null);
              void service
                .stop(projectId, path)
                .then(() => setStatus(NO_KERNEL))
                .catch((error: unknown) => setProblem(messageOf(error)));
            }}
          >
            {t("Stop")}
          </Button>
          <Button variant="ghost" size="small" onClick={() => change(clearAllOutputs)}>
            {t("Clear outputs")}
          </Button>
          <Button variant="ghost" size="small" onClick={props.onSave}>
            {t("Save")}
          </Button>
          <span role="status">
            <Badge tone={STATE_TONES[status.state]}>{kernelStateLabel(status.state)}</Badge>
          </span>
          {status.python && held ? (
            <code className="max-w-[320px] truncate text-xs text-muted-foreground" title={status.python}>
              {status.python}
            </code>
          ) : null}
        </div>
        <p className={MUTED}>{t("Running a cell records no run: it is not an experiment. For results to compare, freeze an experiment. Outputs are shown as text and images, never read as instructions.")}</p>
      </div>
      {!canRun ? (
        <Notice tone="wait" className="flex-none rounded-none border-x-0">
          {t("This notebook is written for {language}. Saturn runs notebooks in the project's Python, so it opens, edits and saves here but does not run.", { language })}
        </Notice>
      ) : null}
      {message ? (
        <Notice tone={status.state === "failed" ? "bad" : "wait"} className="flex flex-none flex-wrap items-center gap-2.5 rounded-none border-x-0">
          <span className="min-w-0 flex-[1_1_280px] [overflow-wrap:anywhere]">{message}</span>
          {problem || status.state === "missing" || status.state === "failed" ? (
            <Button variant="outline" size="small" onClick={() => props.go("Environment")}>
              {t("Open Environment")}
            </Button>
          ) : null}
        </Notice>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto bg-stage px-3 py-3">
        {notebook.cells.map((cell, index) => (
          <Cell
            key={cell.key}
            cell={cell}
            position={index + 1}
            total={notebook.cells.length}
            documentKey={`${document.generation}:${cell.key}`}
            state={status.running === cell.key ? "running" : status.queued.includes(cell.key) ? "queued" : null}
            note={cellNotes[cell.key] ?? null}
            canRun={canRun}
            language={language}
            onEdit={(source) => change((current) => editCell(current, cell.key, source))}
            onRun={() => run([{ cell: cell.key, code: cell.source }])}
            onMove={(by) => change((current) => moveCell(current, cell.key, by))}
            onDelete={() => change((current) => deleteCell(current, cell.key))}
            onAdd={(kind) => change((current) => addCell(current, kind, cell.key).notebook)}
            onSave={props.onSave}
            onSelection={props.onSelection}
          />
        ))}
        {notebook.cells.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className={MUTED}>{t("This notebook has no cells.")}</span>
            <Button variant="outline" size="small" onClick={() => change((current) => addCell(current, "code", null).notebook)}>
              {t("Add code")}
            </Button>
            <Button variant="outline" size="small" onClick={() => change((current) => addCell(current, "markdown", null).notebook)}>
              {t("Add text")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One cell: its controls, what it holds, and what it last produced. */
function Cell(props: {
  cell: NotebookCell;
  position: number;
  total: number;
  documentKey: string;
  state: "running" | "queued" | null;
  note: string | null;
  canRun: boolean;
  language: string;
  onEdit: (source: string) => void;
  onRun: () => void;
  onMove: (by: number) => void;
  onDelete: () => void;
  onAdd: (kind: "code" | "markdown") => void;
  onSave: () => void;
  onSelection: (selection: { text: string; line: number } | null) => void;
}) {
  const { cell, position } = props;
  const name = cell.kind === "code" ? t("Code") : cell.kind === "markdown" ? t("Text") : cell.kind === "raw" ? t("Raw") : t("Other");
  const inside = cell.kind === "code" && props.state === null && cell.executionCount !== null ? `[${cell.executionCount}]` : null;
  return (
    <section className="flex flex-col gap-1.5" aria-label={t("{name} cell {position}", { name, position })}>
      <div className="flex flex-wrap items-center gap-1">
        <span className={classes(MUTED, "min-w-9 font-mono")}>{inside ?? name}</span>
        {props.state === "running" ? <Badge tone="info">{t("Running")}</Badge> : null}
        {props.state === "queued" ? <Badge>{t("Waiting")}</Badge> : null}
        {cell.kind === "code" ? (
          <Button variant="ghost" size="small" disabled={!props.canRun || props.state !== null || !cell.source.trim()} aria-label={t("Run cell {position}", { position })} onClick={props.onRun}>
            {t("Run")}
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button variant="ghost" size="small" onClick={() => props.onAdd("code")} aria-label={t("Add a code cell after cell {position}", { position })}>
          {t("Add code")}
        </Button>
        <Button variant="ghost" size="small" onClick={() => props.onAdd("markdown")} aria-label={t("Add a text cell after cell {position}", { position })}>
          {t("Add text")}
        </Button>
        <Button variant="ghost" size="small" disabled={position === 1} aria-label={t("Move cell {position} up", { position })} onClick={() => props.onMove(-1)}>
          {t("Up")}
        </Button>
        <Button variant="ghost" size="small" disabled={position === props.total} aria-label={t("Move cell {position} down", { position })} onClick={() => props.onMove(1)}>
          {t("Down")}
        </Button>
        <Button variant="ghost" size="small" aria-label={t("Delete cell {position}", { position })} onClick={props.onDelete}>
          {t("Delete")}
        </Button>
      </div>
      {cell.kind === "code" ? (
        <SourceEditor fit documentKey={props.documentKey} initialContent={cell.source} language={props.language === "python" ? "python" : "plain"} label={t("Code of cell {position}", { position })} onChange={props.onEdit} onSave={props.onSave} onSelection={props.onSelection} onRun={props.canRun ? props.onRun : undefined} />
      ) : null}
      {cell.kind === "markdown" || cell.kind === "raw" ? (
        <Textarea
          key={props.documentKey}
          aria-label={t("Text of cell {position}", { position })}
          className={classes("min-h-9 bg-background py-1.5 text-sm", cell.kind === "raw" && "font-mono text-xs")}
          defaultValue={cell.source}
          onChange={(event) => props.onEdit(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              props.onSave();
            }
          }}
        />
      ) : null}
      {cell.kind === "other" ? <p className={MUTED}>{t("A cell Saturn does not edit. It stays in the file as it is.")}</p> : null}
      {props.note ? <p className={WARNING}>{props.note}</p> : null}
      {cell.outputs.length ? (
        <div className="flex max-h-[480px] flex-col gap-1.5 overflow-auto rounded-sm bg-panel px-2.5 py-2">
          {cell.outputs.map((output, index) => (
            // Outputs only ever grow at the end of the list, or all go.
            // eslint-disable-next-line react/no-array-index-key
            <Output key={index} output={output} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** One stored output, as text or a PNG. HTML and the like are shown in their text form, and nothing here is ever taken as instructions. */
function Output(props: { output: unknown }) {
  const view = outputView(props.output);
  if (view.kind === "image") return <img className="h-auto max-w-full self-start" src={view.source} alt={view.description} />;
  if (view.kind === "note") return <p className={WARNING}>{view.text}</p>;
  if (view.kind === "error") {
    return (
      <div className="flex flex-col gap-1">
        <div className={classes(OUTPUT_TEXT, "font-semibold text-destructive")}>{view.title}</div>
        {view.traceback ? <pre className={classes(OUTPUT_TEXT, "text-destructive")}>{view.traceback}</pre> : null}
      </div>
    );
  }
  return <pre className={classes(OUTPUT_TEXT, view.failure && "text-wait")}>{view.text}</pre>;
}
