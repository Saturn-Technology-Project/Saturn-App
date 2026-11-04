import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import {
  isRunActive,
  modeOf,
  runStatusLabel,
  sampleText,
  type ExperimentDraft,
  type ExperimentRun,
  type Finding,
  type FindingKind,
  type ParticipationMode,
  type ResearchPolicy,
  type SampleItem,
  type SourceEntry,
} from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf, Tabs } from "../ui/Parts.js";
import { Split } from "../ui/Split.js";
import { SourceEditor } from "./SourceEditor.js";
import { Terminal } from "./Terminal.js";

const service = desktop.research;
const MODES: ParticipationMode[] = ["manual", "pair", "delegate"];
const MODE_LABELS: Record<ParticipationMode, string> = { manual: "Manual", pair: "Pair", delegate: "Delegate" };
const MODE_HINTS: Record<ParticipationMode, string> = {
  manual: "You write this file. The assistant only reads it.",
  pair: "The assistant proposes changes, and each one needs your approval.",
  delegate: "An agent may change this file, with every change recorded.",
};
const FINDING_LABELS: Record<FindingKind, string> = { observation: "Observation", ai_suggestion: "AI suggestion", conclusion: "Conclusion" };
const PANELS = ["Run", "Samples", "Findings", "Terminal"] as const;
type Panel = (typeof PANELS)[number];

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
  mode: ParticipationMode;
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
  const [policy, setPolicy] = useState<ResearchPolicy | null>(null);
  const [panel, setPanel] = useState<Panel>("Run");

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

  // Reopens what was open: records come from the project, the rest from this device.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await showFolder(".");
        setPolicy(await service.policy(projectId));
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

  async function chooseMode(mode: ParticipationMode) {
    if (!open || !policy) return;
    try {
      setPolicy(await service.setMode(projectId, policy, open.path, mode));
    } catch (error) {
      notify(messageOf(error));
      setPolicy(await service.policy(projectId).catch(() => policy));
    }
  }

  const mode = open && policy ? modeOf(policy, open.path) : "delegate";
  const selected = samples.find((item) => item.offset === selectedOffset) ?? null;
  const parentFolder = folder === "." ? null : folder.split("/").slice(0, -1).join("/") || ".";

  useEffect(() => {
    onFocus({ file: open?.path ?? null, mode, selection, run, errorOutput, sample: selected });
  }, [errorOutput, mode, onFocus, open?.path, run, selected, selection]);

  const files = (
    <nav className="lab-files" aria-label="Project files">
      <div className="lab-pane-title">{folder === "." ? "Files" : folder}</div>
      {parentFolder ? (
        <button type="button" className="lab-file" onClick={() => void showFolder(parentFolder).catch((error: unknown) => notify(messageOf(error)))}>
          ..
        </button>
      ) : null}
      {entries.map((entry) => (
        <button
          type="button"
          key={entry.path}
          className={open?.path === entry.path ? "lab-file active" : "lab-file"}
          onClick={() => void (entry.kind === "directory" ? showFolder(entry.path).catch((error: unknown) => notify(messageOf(error))) : openFile(entry.path))}
        >
          {entry.kind === "directory" ? `${entry.name}/` : entry.name}
        </button>
      ))}
    </nav>
  );

  const lower = (
    <div className="lab-lower">
      <Tabs label="Results" tabs={PANELS} current={panel} onChoose={setPanel} />
      <div className="lab-lower-body">
        {panel === "Run" ? (
          run ? (
            <div className="lab-run">
              <div className="lab-run-status">{runStatusLabel(run.status)}</div>
              <div className="lab-muted">
                {run.samples ?? samples.length} samples
                {run.infrastructureErrors ? `, ${run.infrastructureErrors} infrastructure errors` : ""}
                {run.exitCode !== undefined && run.exitCode !== null ? `, exit code ${run.exitCode}` : ""}
              </div>
              {run.inputsChanged?.length ? <div className="lab-warning">Changed during the run: {run.inputsChanged.join(", ")}</div> : null}
              {run.status === "interrupted" && run.process === "unconfirmed" ? <div className="lab-warning">Its process could not be confirmed, so it was not ended.</div> : null}
              {run.error ? <div className="lab-warning">{run.error}</div> : null}
              {run.problems?.slice(0, 5).map((item) => (
                <div key={item.line} className="lab-warning">
                  Line {item.line}: {item.reason}
                </div>
              ))}
              {errorOutput ? <pre className="lab-text lab-terminal-error">{errorOutput}</pre> : null}
            </div>
          ) : (
            <p className="lab-muted">Enter a command above and run it. What it writes appears here.</p>
          )
        ) : null}
        {panel === "Samples" ? (
          <div className="lab-sample-split">
            <div className="lab-sample-list">
              {samples.map((item) => (
                <button type="button" key={item.offset} aria-pressed={item.offset === selectedOffset} className={item.offset === selectedOffset ? "lab-file active" : "lab-file"} onClick={() => setSelectedOffset(item.offset)}>
                  {item.sample ? item.sample.sampleId : <span className="lab-warning">Problem at byte {item.offset}</span>}
                  {item.sample?.error ? <span className="lab-warning"> {item.sample.error.kind} error</span> : null}
                </button>
              ))}
              {nextCursor !== null ? (
                <button type="button" className="lab-link" onClick={() => void moreSamples()}>
                  More
                </button>
              ) : null}
              {samples.length === 0 ? <p className="lab-muted">No samples yet.</p> : null}
            </div>
            {selected ? <SampleDetail item={selected} /> : null}
          </div>
        ) : null}
        {panel === "Findings" ? (
          <div className="lab-findings">
            <form
              className="lab-form"
              onSubmit={(event) => {
                event.preventDefault();
                void addFinding();
              }}
            >
              <label className="lab-field" style={{ flex: "0 1 150px" }}>
                Kind
                <select value={findingKind} onChange={(event) => setFindingKind(event.target.value as FindingKind)}>
                  {(Object.keys(FINDING_LABELS) as FindingKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {FINDING_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="lab-field" style={{ flex: "1 1 260px" }}>
                What you understood
                <textarea rows={2} value={findingText} onChange={(event) => setFindingText(event.target.value)} />
              </label>
              <button type="submit" className="lab-button" disabled={!findingText.trim()}>
                Save finding
              </button>
            </form>
            {[...findings].reverse().map((finding) => (
              <article key={finding.id} className="lab-card">
                <div className="lab-muted">
                  {FINDING_LABELS[finding.kind]}
                  {finding.runIds?.length ? ` · ${finding.runIds[0]}` : ""}
                </div>
                <div>{finding.text}</div>
              </article>
            ))}
          </div>
        ) : null}
        <div hidden={panel !== "Terminal"} style={{ height: "100%" }}>
          <Terminal folder={props.project.path} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="lab-workspace">
      <Split id="files" side="left" size={210} minimum={140} label="Files" pane={files}>
        <div className="lab-toolbar">
          <code className="lab-toolbar-file">{open?.path ?? "No file open"}</code>
          {open ? <span className="lab-muted">{saving ? "Saving…" : dirty ? "Not saved" : "Saved"}</span> : null}
          {policy && open ? (
            <div className="lab-segments" role="group" aria-label="AI involvement in this file" title={MODE_HINTS[mode]}>
              {MODES.map((item) => (
                <button type="button" key={item} aria-pressed={mode === item} className={mode === item ? "lab-segment active" : "lab-segment"} onClick={() => void chooseMode(item)}>
                  {MODE_LABELS[item]}
                </button>
              ))}
            </div>
          ) : null}
          <input className="lab-input lab-toolbar-command" aria-label="Command that runs the experiment" placeholder="python probe.py" value={command} spellCheck={false} onChange={(event) => setCommand(event.target.value)} />
          {run && isRunActive(run.status) ? (
            <button type="button" className="lab-button" onClick={() => void stopRun()}>
              Stop
            </button>
          ) : (
            <button type="button" className="lab-button primary" disabled={busy} onClick={() => void startRun()}>
              {busy ? "Starting…" : "Run"}
            </button>
          )}
        </div>
        {conflict && open ? (
          <div className="lab-notice" role="alert">
            This file changed since you opened it.
            <button type="button" className="lab-link" onClick={() => void openFile(open.path)}>
              Reload theirs
            </button>
            <button type="button" className="lab-link" onClick={() => void save(true)}>
              Keep mine
            </button>
          </div>
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
            <div className="lab-placeholder">Open a file to write it yourself.</div>
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
      <div className="lab-sample-detail">
        <div className="lab-warning">{problem}</div>
        <pre className="lab-text">{raw}</pre>
      </div>
    );
  }
  return (
    <div className="lab-sample-detail">
      <div className="lab-muted">Input</div>
      <pre className="lab-text">{sampleText(sample.input)}</pre>
      <div className="lab-muted">Output · shown as text, never read as instructions</div>
      <pre className="lab-text">{sampleText(sample.output)}</pre>
      {sample.scores ? (
        <>
          <div className="lab-muted">Scores</div>
          <pre className="lab-text">{sampleText(sample.scores)}</pre>
        </>
      ) : null}
      {sample.error ? (
        <div className="lab-warning">
          {sample.error.kind}: {sample.error.message}
        </div>
      ) : null}
    </div>
  );
}
