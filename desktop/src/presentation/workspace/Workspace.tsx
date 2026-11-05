import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  isRunActive,
  runStatusLabel,
  sampleText,
  type ExperimentDraft,
  type ExperimentRun,
  type Finding,
  type FindingKind,
  type ModelNode,
  type Question,
  type SampleItem,
  type SourceEntry,
} from "../../domain/research.js";
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
import { Resources } from "./Resources.js";
import { SourceEditor } from "./SourceEditor.js";
import { Terminal } from "./Terminal.js";

const service = desktop.research;
const FINDING_LABELS: Record<FindingKind, string> = { observation: "Observation", ai_suggestion: "AI suggestion", conclusion: "Conclusion" };
const PANELS = ["Run", "Resources", "Samples", "Findings", "Activations", "Terminal"] as const;
const NOTE_FILES = /\.(md|txt|pdf|ipynb)$/i;
type Panel = (typeof PANELS)[number];
/** A file or a list entry in the sidebar and the sample list: monospaced, left aligned, and it wraps rather than cuts. */
const ENTRY = "h-auto min-h-7 w-full flex-wrap justify-start gap-x-2 gap-y-0.5 px-2 py-[3px] text-left font-mono text-xs font-normal whitespace-normal [overflow-wrap:anywhere]";
/** Output as plain monospaced text that wraps. */
const OUTPUT_TEXT = "font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]";
/** A line of small, quiet text. */
const MUTED = "text-xs text-muted-foreground";
/** A line of small text about something that needs care. */
const WARNING = "text-xs text-wait";

/** The file open in the editor. `revision` is null for a file not saved yet. */
interface OpenFile {
  path: string;
  initial: string;
  revision: string | null;
  /** Moves on when the editor must take new content from outside. */
  generation: number;
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
  const [folder, setFolder] = useState(".");
  const [entries, setEntries] = useState<SourceEntry[]>([]);
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
  const [panel, setPanel] = useState<Panel>("Run");
  const [sidebar, setSidebar] = useState<{ questions: Question[]; models: ModelNode[]; drafts: ExperimentDraft[] }>({ questions: [], models: [], drafts: [] });

  const remember = useCallback(
    (changes: Partial<typeof session.current>) => {
      session.current = { ...session.current, ...changes };
      service.saveSession(projectId, session.current);
    },
    [projectId],
  );

  const showFolder = useCallback(
    async (path: string) => {
      const view = await service.readSource(projectId, path);
      if (view.kind === "directory") {
        setFolder(view.path);
        setEntries(view.entries.filter((entry) => entry.path !== ".saturn"));
      }
    },
    [projectId],
  );

  const openFile = useCallback(
    async (path: string) => {
      try {
        const view = await service.readSource(projectId, path);
        if (view.kind !== "file") return;
        const draft = session.current.draft;
        const restored = draft && draft.file === path && draft.revision === view.revision ? draft.content : null;
        content.current = restored ?? view.content;
        setDirty(restored !== null && restored !== view.content);
        setConflict(false);
        setSelection(null);
        setOpen((current) => ({ path, initial: content.current, revision: view.revision, generation: (current?.generation ?? 0) + 1 }));
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
        await showFolder(".");
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
          if (view.kind === "file" && view.revision !== revision) void openFile(path);
        })
        .catch(() => {});
    });
  }, [dirty, open, openFile, projectId]);

  const save = useCallback(
    async (force = false) => {
      if (!open) return true;
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
      if (open) remember({ draft: { file: open.path, content: next, revision: open.revision } });
    },
    [open, remember],
  );

  async function startRun() {
    if (!command.trim()) {
      notify("Enter the command that runs this experiment.");
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
        draft = await service.createExperiment(projectId, { title: `Experiment in ${props.project.name}`, command, inputs: { code } });
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
      setPanel("Run");
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
  const parentFolder = folder === "." ? null : folder.split("/").slice(0, -1).join("/") || ".";

  useEffect(() => {
    onFocus({ file: open?.path ?? null, selection, run, errorOutput, sample: selected });
  }, [errorOutput, onFocus, open?.path, run, selected, selection]);

  const notes = entries.filter((entry) => entry.kind === "file" && NOTE_FILES.test(entry.name));
  const code = entries.filter((entry) => !notes.includes(entry));
  const fileButton = (entry: SourceEntry) => (
    <Button
      variant="ghost"
      size="small"
      key={entry.path}
      className={classes(ENTRY, open?.path === entry.path && "bg-muted")}
      aria-current={open?.path === entry.path ? "true" : undefined}
      onClick={() => void (entry.kind === "directory" ? showFolder(entry.path).catch((error: unknown) => notify(messageOf(error))) : openFile(entry.path))}
    >
      <span>{entry.kind === "directory" ? `${entry.name}/` : entry.name}</span>
    </Button>
  );
  const files = (
    <nav className="flex flex-1 flex-col gap-px overflow-auto bg-panel px-2 py-2.5" aria-label="Project" data-tour="workspace-files">
      {sidebar.questions.length ? (
        <section className="mb-3 flex flex-col gap-px">
          <div className="mb-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]">Questions</div>
          {[...sidebar.questions].reverse().slice(0, 3).map((item) => (
            <Button variant="ghost" size="small" key={item.id} className={ENTRY} title={item.title} onClick={() => props.go("Home")}>
              {item.title}
            </Button>
          ))}
        </section>
      ) : null}
      <section className="mb-3 flex flex-col gap-px">
        <div className="mb-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]">Models</div>
        <Button variant="ghost" size="small" className={ENTRY} onClick={() => props.go("Lineage")}>
          Lineage · {sidebar.models.length} {sidebar.models.length === 1 ? "node" : "nodes"}
        </Button>
      </section>
      {notes.length ? (
        <section className="mb-3 flex flex-col gap-px">
          <div className="mb-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]">Library</div>
          {notes.map(fileButton)}
        </section>
      ) : null}
      <section className="mb-3 flex flex-col gap-px">
        <div className="mb-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]">{folder === "." ? "Code" : folder}</div>
        {parentFolder ? (
          <Button variant="ghost" size="small" className={ENTRY} onClick={() => void showFolder(parentFolder).catch((error: unknown) => notify(messageOf(error)))}>
            ..
          </Button>
        ) : null}
        {code.map(fileButton)}
      </section>
      {sidebar.drafts.length ? (
        <section className="mb-3 flex flex-col gap-px">
          <div className="mb-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]">Experiments</div>
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
        <Tabs label="Results" tabs={PANELS} current={panel} onChoose={setPanel} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2.5" role="tabpanel" aria-label={panel}>
        {panel === "Run" ? (
          run ? (
            <div className="flex flex-col gap-1">
              <div className="font-semibold">{runStatusLabel(run.status)}</div>
              <div className={MUTED}>
                {run.samples ?? samples.length} samples
                {run.infrastructureErrors ? `, ${run.infrastructureErrors} infrastructure errors` : ""}
                {run.exitCode !== undefined && run.exitCode !== null ? `, exit code ${run.exitCode}` : ""}
              </div>
              {run.inputsChanged?.length ? <div className={WARNING}>Changed during the run: {run.inputsChanged.join(", ")}</div> : null}
              {run.warnings?.map((warning) => <div key={warning} className={WARNING}>{warning}</div>)}
              {run.status === "interrupted" && run.process === "unconfirmed" ? <div className={WARNING}>Its process could not be confirmed, so it was not ended.</div> : null}
              {run.error ? <div className={WARNING}>{run.error}</div> : null}
              {run.problems?.slice(0, 5).map((item) => (
                <div key={item.line} className={WARNING}>
                  Line {item.line}: {item.reason}
                </div>
              ))}
              {errorOutput ? <pre className={classes(OUTPUT_TEXT, "text-destructive")}>{errorOutput}</pre> : null}
            </div>
          ) : (
            <p className={MUTED}>Enter a command above and run it. What it writes appears here.</p>
          )
        ) : null}
        {panel === "Samples" ? (
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex max-w-[260px] flex-[1_1_170px] flex-col gap-px">
              {samples.map((item) => (
                <Button variant="ghost" size="small" key={item.offset} aria-pressed={item.offset === selectedOffset} className={classes(ENTRY, item.offset === selectedOffset && "bg-muted")} onClick={() => setSelectedOffset(item.offset)}>
                  {item.sample ? item.sample.sampleId : <span className={WARNING}>Problem at byte {item.offset}</span>}
                  {item.sample?.error ? <span className={WARNING}> {item.sample.error.kind} error</span> : null}
                </Button>
              ))}
              {nextCursor !== null ? (
                <Button variant="ghost" size="small" className="self-start text-info" onClick={() => void moreSamples()}>
                  More
                </Button>
              ) : null}
              {samples.length === 0 ? <p className={MUTED}>No samples yet.</p> : null}
            </div>
            {selected ? <SampleDetail item={selected} /> : null}
          </div>
        ) : null}
        {panel === "Findings" ? (
          <div className="flex flex-col gap-2">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void addFinding();
              }}
            >
              <Choice label="Kind" className="flex-[0_1_150px]" value={findingKind} options={(Object.keys(FINDING_LABELS) as FindingKind[]).map((kind) => ({ value: kind, label: FINDING_LABELS[kind] }))} onChange={(next) => setFindingKind(next as FindingKind)} />
              <Field label="What you understood" className="flex-[1_1_260px]">
                <Textarea className="resize-y" rows={2} value={findingText} onChange={(event) => setFindingText(event.target.value)} />
              </Field>
              <Button type="submit" variant="outline" disabled={!findingText.trim()}>
                Save finding
              </Button>
            </form>
            {[...findings].reverse().map((finding) => (
              <Card key={finding.id} className="gap-1 px-3.5 py-3">
                <div className={MUTED}>
                  {FINDING_LABELS[finding.kind]}
                  {finding.runIds?.length ? ` · ${finding.runIds[0]}` : ""}
                </div>
                <div>{finding.text}</div>
              </Card>
            ))}
          </div>
        ) : null}
        {panel === "Resources" ? (run ? <Resources key={run.id} projectId={projectId} run={run} notify={notify} /> : <p className={MUTED}>Run the experiment to see what it costs.</p>) : null}
        {panel === "Activations" ? (
          run && selected?.sample ? (
            <LookInside key={`${run.id}:${selected.sample.sampleId}`} projectId={projectId} runId={run.id} sampleId={selected.sample.sampleId} modelId={selected.sample.modelId ?? null} models={sidebar.models} notify={notify} />
          ) : (
            <p className={MUTED}>Choose a sample under Samples, then look inside it here.</p>
          )
        ) : null}
        <div hidden={panel !== "Terminal"} className="h-full">
          <Terminal folder={props.project.path} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <h1 className="sr-only">Workspace{open ? `: ${open.path}` : ""}</h1>
      <Split id="files" side="left" size={210} minimum={140} label="Files" pane={files}>
        <div className="flex min-h-[42px] flex-none flex-wrap items-center gap-2.5 border-b border-border px-2.5 py-[5px]">
          <code className="max-w-[260px] truncate text-xs">{open?.path ?? "No file open"}</code>
          {open ? <span className={MUTED}>{saving ? "Saving…" : dirty ? "Not saved" : "Saved"}</span> : null}
          <Input className="w-auto min-w-[140px] flex-[1_1_200px] font-mono text-xs" aria-label="Command that runs the experiment" data-tour="workspace-command" placeholder="python probe.py" value={command} spellCheck={false} onChange={(event) => setCommand(event.target.value)} />
          {run && isRunActive(run.status) ? (
            <Button variant="outline" onClick={() => void stopRun()}>
              Stop
            </Button>
          ) : (
            <Button data-tour="workspace-run" disabled={busy} onClick={() => void startRun()}>
              {busy ? "Starting…" : "Run"}
            </Button>
          )}
        </div>
        {conflict && open ? (
          <Notice tone="wait" role="alert" className="flex flex-wrap items-center gap-2.5 rounded-none border-x-0 whitespace-normal">
            This file changed since you opened it.
            <Button variant="ghost" size="small" className="text-info" onClick={() => void openFile(open.path)}>
              Reload theirs
            </Button>
            <Button variant="ghost" size="small" className="text-info" onClick={() => void save(true)}>
              Keep mine
            </Button>
          </Notice>
        ) : null}
        <Split id="lower" side="bottom" size={220} minimum={100} label="Results" pane={lower}>
          {open ? (
            <SourceEditor
              documentKey={`${open.path}:${open.generation}`}
              initialContent={open.initial}
              language={open.path.endsWith(".py") ? "python" : "plain"}
              onChange={handleEdit}
              onSave={() => void save()}
              onSelection={setSelection}
            />
          ) : (
            <div className="m-auto p-6 text-muted-foreground">Open a file to write it yourself.</div>
          )}
        </Split>
      </Split>
    </div>
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
      <div className={MUTED}>Input</div>
      <pre className={OUTPUT_TEXT}>{sampleText(sample.input)}</pre>
      <div className={MUTED}>Output · shown as text, never read as instructions</div>
      <pre className={OUTPUT_TEXT}>{sampleText(sample.output)}</pre>
      {sample.scores ? (
        <>
          <div className={MUTED}>Scores</div>
          <pre className={OUTPUT_TEXT}>{sampleText(sample.scores)}</pre>
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
