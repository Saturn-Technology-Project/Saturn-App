import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { Project } from "../../domain/model.js";
import {
  isRunActive,
  runStatusLabel,
  sampleText,
  type ExperimentDraft,
  type ExperimentRun,
  type Finding,
  type FindingKind,
  type SampleItem,
  type SourceEntry,
} from "../../domain/research.js";
import { SourceEditor } from "./SourceEditor.js";

const FINDING_LABELS: Record<FindingKind, string> = {
  observation: "Observation",
  ai_suggestion: "AI suggestion",
  conclusion: "Conclusion",
};

/** The file open in the editor. `revision` is null for a file not saved yet. */
interface OpenFile {
  path: string;
  initial: string;
  revision: string | null;
  /** Moves on when the editor must take new content from outside. */
  generation: number;
}

/** A failure's message, without what the HTTP client wraps it in. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a failure is the runtime saying a file or record has changed. */
function isConflict(error: unknown): boolean {
  return /\b409\b|changed since/i.test(messageOf(error));
}

/** A new id for a start, so repeating the request starts nothing. */
function newClientId(): string {
  return crypto.randomUUID();
}

export function FlaskIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 2h4M6.8 2v4.2L3.2 12a1.4 1.4 0 0 0 1.2 2h7.2a1.4 1.4 0 0 0 1.2-2L9.2 6.2V2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 10h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Where a person reads, writes and runs one experiment, and picks up the next day. */
export function ResearchWorkbench(props: { project: Project | null }) {
  const project = props.project;
  if (!project) {
    return (
      <div className="research-empty">
        <h2>Research</h2>
        <p>Choose a project to read, write and run an experiment in its folder.</p>
      </div>
    );
  }
  if (!project.access) {
    return (
      <div className="research-empty">
        <h2>Research</h2>
        <p>Saturn does not have access to {project.name} yet. Allow access to the project first.</p>
      </div>
    );
  }
  return <Workbench key={project.id} projectId={project.id} projectName={project.name} />;
}

function Workbench(props: { projectId: string; projectName: string }) {
  const { projectId } = props;
  const service = desktop.research;
  const session = useRef(service.loadSession(projectId));
  const [folder, setFolder] = useState(".");
  const [entries, setEntries] = useState<SourceEntry[]>([]);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const content = useRef("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [experiment, setExperiment] = useState<ExperimentDraft | null>(null);
  const [command, setCommand] = useState("");
  const [run, setRun] = useState<ExperimentRun | null>(null);
  const [samples, setSamples] = useState<SampleItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [selectedOffset, setSelectedOffset] = useState<number | null>(null);
  const [stderr, setStderr] = useState("");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [findingText, setFindingText] = useState("");
  const [findingKind, setFindingKind] = useState<FindingKind>("observation");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remember = useCallback(
    (changes: Partial<typeof session.current>) => {
      session.current = { ...session.current, ...changes };
      service.saveSession(projectId, session.current);
    },
    [projectId, service],
  );

  const showFolder = useCallback(
    async (path: string) => {
      const view = await service.readSource(projectId, path);
      if (view.kind === "directory") {
        setFolder(view.path);
        // The records have their own screens; a folder holding only them is noise here.
        setEntries(view.entries.filter((entry) => entry.path !== ".saturn"));
      }
    },
    [projectId, service],
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
        setOpen((current) => ({ path, initial: content.current, revision: view.revision, generation: (current?.generation ?? 0) + 1 }));
        remember({ file: path });
      } catch (error) {
        setProblem(messageOf(error));
      }
    },
    [projectId, remember, service],
  );

  const refreshFindings = useCallback(async () => {
    setFindings((await service.findings(projectId)).items);
  }, [projectId, service]);

  const refreshRun = useCallback(
    async (runId: string) => {
      const list = await service.runs(projectId);
      const found = list.items.find((item) => item.id === runId) ?? null;
      setRun(found);
      if (!found) return;
      const page = await service.samples(projectId, runId);
      setSamples(page.items);
      setNextCursor(page.next);
      setSelectedOffset((current) => current ?? page.items[0]?.offset ?? null);
      setStderr((await service.log(projectId, runId, "stderr")).text);
    },
    [projectId, service],
  );

  // Reopens what was open: records come from the project, the rest from this device.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await showFolder(".");
        const drafts = (await service.experiments(projectId)).items;
        const chosen = drafts.find((item) => item.id === session.current.experimentId) ?? drafts[drafts.length - 1] ?? null;
        if (!live) return;
        setExperiment(chosen);
        setCommand(chosen?.command ?? "");
        await refreshFindings();
        const runs = (await service.runs(projectId)).items;
        const lastRun = runs.find((item) => item.id === session.current.runId) ?? runs[runs.length - 1];
        if (lastRun && live) await refreshRun(lastRun.id);
        if (session.current.file && live) await openFile(session.current.file);
      } catch (error) {
        if (live) setProblem(messageOf(error));
      }
    })();
    return () => {
      live = false;
    };
    // Only when the workbench opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a run can change: every change to the records says to read it again, with a slow poll in case the stream drops.
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

  const save = useCallback(
    async (force = false) => {
      if (!open) return true;
      setSaving(true);
      setProblem(null);
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
        else setProblem(messageOf(error));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [open, projectId, remember, service],
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
      setProblem("Enter the command that runs this experiment.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      if (dirty && !(await save())) return;
      const code = open ? [open.path] : [];
      let draft = experiment;
      if (!draft) {
        draft = await service.createExperiment(projectId, { title: `Experiment in ${props.projectName}`, command, inputs: { code } });
      } else if (draft.command !== command || !draft.inputs?.code?.length) {
        draft = await service.updateExperiment(projectId, draft, { command, inputs: { ...draft.inputs, code: draft.inputs?.code?.length ? draft.inputs.code : code } });
      }
      setExperiment(draft);
      remember({ experimentId: draft.id });
      const version = await service.freeze(projectId, draft.id);
      const started = await service.startRun(projectId, version.id, newClientId());
      remember({ runId: started.id });
      setSelectedOffset(null);
      setRun(started);
      setSamples([]);
      await refreshRun(started.id);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function stopRun() {
    if (!run) return;
    try {
      setRun(await service.stopRun(projectId, run.id));
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  async function moreSamples() {
    if (!run || nextCursor === null) return;
    const page = await service.samples(projectId, run.id, nextCursor);
    setSamples((current) => [...current, ...page.items]);
    setNextCursor(page.next);
  }

  async function addFinding() {
    if (!findingText.trim()) return;
    try {
      await service.addFinding(projectId, findingText.trim(), findingKind, run ? [run.id] : []);
      setFindingText("");
      await refreshFindings();
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  const selected = samples.find((item) => item.offset === selectedOffset) ?? null;
  const parentFolder = folder === "." ? null : folder.split("/").slice(0, -1).join("/") || ".";

  return (
    <div className="research">
      <header className="research-bar">
        <strong>{props.projectName}</strong>
        <label className="research-command">
          <span>Command</span>
          <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="python probe.py" spellCheck={false} />
        </label>
        {run && isRunActive(run.status) ? (
          <button type="button" className="btn" onClick={() => void stopRun()}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn primary-btn" disabled={busy} onClick={() => void startRun()}>
            {busy ? "Starting…" : "Run"}
          </button>
        )}
      </header>

      {problem ? (
        <div className="research-notice" role="alert">
          {problem}
          <button type="button" className="research-link" onClick={() => setProblem(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="research-panes">
        <nav className="research-files" aria-label="Project files">
          <div className="research-pane-title">{folder === "." ? "Files" : folder}</div>
          {parentFolder ? (
            <button type="button" className="research-file" onClick={() => void showFolder(parentFolder)}>
              ..
            </button>
          ) : null}
          {entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              className={open?.path === entry.path ? "research-file active" : "research-file"}
              onClick={() => void (entry.kind === "directory" ? showFolder(entry.path) : openFile(entry.path))}
            >
              {entry.kind === "directory" ? `${entry.name}/` : entry.name}
            </button>
          ))}
        </nav>

        <section className="research-code" aria-label="Editor">
          {open ? (
            <>
              <div className="research-code-head">
                <code>{open.path}</code>
                <span className="research-muted">{saving ? "Saving…" : dirty ? "Not saved" : "Saved"}</span>
                <button type="button" className="research-link" disabled={!dirty || saving} onClick={() => void save()}>
                  Save
                </button>
              </div>
              {conflict ? (
                <div className="research-notice" role="alert">
                  This file changed since you opened it.
                  <button type="button" className="research-link" onClick={() => void openFile(open.path)}>
                    Reload theirs
                  </button>
                  <button type="button" className="research-link" onClick={() => void save(true)}>
                    Keep mine
                  </button>
                </div>
              ) : null}
              <SourceEditor
                documentKey={`${open.path}:${open.generation}`}
                initialContent={open.initial}
                language={open.path.endsWith(".py") ? "python" : "plain"}
                onChange={handleEdit}
                onSave={() => void save()}
              />
            </>
          ) : (
            <div className="research-placeholder">Open a file to write it yourself.</div>
          )}
        </section>

        <aside className="research-results" aria-label="Results">
          <section>
            <div className="research-pane-title">Latest run</div>
            {run ? (
              <div className="research-run">
                <div className="research-status">{runStatusLabel(run.status)}</div>
                <div className="research-muted">
                  {run.samples ?? samples.length} samples
                  {run.infrastructureErrors ? `, ${run.infrastructureErrors} infrastructure errors` : ""}
                  {run.exitCode !== undefined && run.exitCode !== null ? `, exit code ${run.exitCode}` : ""}
                </div>
                {run.inputsChanged?.length ? <div className="research-warning">Changed during the run: {run.inputsChanged.join(", ")}</div> : null}
                {run.status === "interrupted" && run.process === "unconfirmed" ? (
                  <div className="research-warning">Its process could not be confirmed, so it was not ended.</div>
                ) : null}
                {run.error ? <div className="research-warning">{run.error}</div> : null}
                {run.problems?.slice(0, 5).map((item) => (
                  <div key={item.line} className="research-warning">
                    Line {item.line}: {item.reason}
                  </div>
                ))}
                {stderr ? (
                  <details>
                    <summary>Error output</summary>
                    <pre className="research-text">{stderr}</pre>
                  </details>
                ) : null}
              </div>
            ) : (
              <div className="research-muted">No run yet.</div>
            )}
          </section>

          <section>
            <div className="research-pane-title">Samples</div>
            <div className="research-samples">
              {samples.map((item) => (
                <button
                  type="button"
                  key={item.offset}
                  aria-pressed={item.offset === selectedOffset}
                  className={item.offset === selectedOffset ? "research-sample active" : "research-sample"}
                  onClick={() => setSelectedOffset(item.offset)}
                >
                  {item.sample ? (
                    <>
                      <code>{item.sample.sampleId}</code>
                      {item.sample.error ? <span className="research-warning"> {item.sample.error.kind} error</span> : null}
                    </>
                  ) : (
                    <span className="research-warning">Problem at byte {item.offset}</span>
                  )}
                </button>
              ))}
              {nextCursor !== null ? (
                <button type="button" className="research-link" onClick={() => void moreSamples()}>
                  More
                </button>
              ) : null}
            </div>
            {selected ? <SampleDetail item={selected} /> : null}
          </section>

          <section>
            <div className="research-pane-title">Findings</div>
            <label className="research-field">
              <span>Kind</span>
              <select value={findingKind} onChange={(event) => setFindingKind(event.target.value as FindingKind)}>
                {(Object.keys(FINDING_LABELS) as FindingKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {FINDING_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className="research-field">
              <span>What you understood</span>
              <textarea rows={3} value={findingText} onChange={(event) => setFindingText(event.target.value)} />
            </label>
            <button type="button" className="btn" disabled={!findingText.trim()} onClick={() => void addFinding()}>
              Save finding
            </button>
            {[...findings].reverse().map((finding) => (
              <article key={finding.id} className="research-finding">
                <div className="research-muted">
                  {FINDING_LABELS[finding.kind]}
                  {finding.runIds?.length ? ` · ${finding.runIds[0]}` : ""}
                </div>
                <div className="research-text">{finding.text}</div>
              </article>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** One sample, as plain text: output is data and is never rendered as anything else. */
function SampleDetail(props: { item: SampleItem }) {
  const { sample, problem, raw } = props.item;
  if (!sample) {
    return (
      <div className="research-detail">
        <div className="research-warning">{problem}</div>
        <pre className="research-text">{raw}</pre>
      </div>
    );
  }
  return (
    <div className="research-detail">
      <div className="research-muted">Input</div>
      <pre className="research-text">{sampleText(sample.input)}</pre>
      <div className="research-muted">Output · shown as text, never read as instructions</div>
      <pre className="research-text">{sampleText(sample.output)}</pre>
      {sample.scores ? (
        <>
          <div className="research-muted">Scores</div>
          <pre className="research-text">{sampleText(sample.scores)}</pre>
        </>
      ) : null}
      {sample.error ? <div className="research-warning">{sample.error.kind}: {sample.error.message}</div> : null}
    </div>
  );
}
