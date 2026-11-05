import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { bytesText, devicesText, kitState, type EnvironmentKit, type ExperimentDraft } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;
const JOB_LABELS = { create: "Making the environment", install: "Installing", sync: "Syncing from the lock file" } as const;

/** The Python the project's experiments run in: a managed one Saturn makes and fills, or any other, what it has, and the files that pin it. */
export function Environment(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(async () => ({ environment: await service.environment(projectId), drafts: (await service.experiments(projectId)).items }), props.notify);
  const [python, setPython] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [withCore, setWithCore] = useState(true);
  const [version, setVersion] = useState("");
  const [extra, setExtra] = useState("");
  const record = value?.environment ?? null;
  const shown = python ?? record?.python ?? record?.suggestedPython ?? "";
  const job = record?.job ?? null;
  const running = job?.status === "running";
  const managed = record?.tools.managed;

  // A running job is read again every two seconds, so its log moves.
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh, running]);

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  async function save() {
    await act(() => service.setEnvironment(projectId, shown.trim()));
    setPython(null);
  }

  async function check() {
    setChecking(true);
    try {
      if (python !== null || (!record?.python && record?.suggestedPython)) await service.setEnvironment(projectId, shown.trim());
      setPython(null);
      await service.checkEnvironment(projectId);
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    } finally {
      setChecking(false);
    }
  }

  /** Adds a lock file to an experiment's environment inputs, so freezing a version records its hash. */
  async function pin(draft: ExperimentDraft, path: string) {
    const current = draft.inputs?.environment ?? [];
    if (current.includes(path)) return;
    await act(() => service.updateExperiment(projectId, draft, { inputs: { ...draft.inputs, environment: [...current, path] } }));
  }

  const report = record?.report ?? null;
  const newest = value?.drafts.at(-1);
  const tool = record?.tools.uv ? "uv" : record?.tools.python3 ? "python3 -m venv" : null;

  return (
    <Page title="Environment" lead="Experiments and looking inside run with this Python. Saturn can make one in the project and fill it with what the work needs; it installs nothing you did not ask for.">
      <h2>Managed environment</h2>
      {record ? (
        managed?.exists ? (
          <div className="lab-card">
            <div className="lab-row">
              <span>
                <code>{managed.path}</code> in the project{record.python === managed.python ? ", in use" : ""}
              </span>
              {record.python !== managed.python ? (
                <button type="button" className="lab-button" onClick={() => void act(() => service.setEnvironment(projectId, managed.python))}>
                  Use it
                </button>
              ) : null}
              <button type="button" className="lab-button" disabled={running || !record.lockFiles.length} title={record.lockFiles.length ? "Brings it to what the lock file says" : "No lock file at the project's root"} onClick={() => void act(() => service.installPackages(projectId, { sync: true }))}>
                Sync from lock file
              </button>
            </div>
            <form
              className="lab-form"
              onSubmit={(event) => {
                event.preventDefault();
                const names = extra.split(/[\s,]+/).filter(Boolean);
                if (names.length) void act(() => service.installPackages(projectId, { packages: names })).then(() => setExtra(""));
              }}
            >
              <label className="lab-field" style={{ flex: "1 1 280px" }}>
                Other packages
                <input value={extra} placeholder="rich scipy>=1.10" spellCheck={false} onChange={(event) => setExtra(event.target.value)} />
              </label>
              <button type="submit" className="lab-button" disabled={running || !extra.trim()}>
                Install
              </button>
            </form>
          </div>
        ) : (
          <div className="lab-card">
            {tool ? (
              <>
                <div>No managed environment yet. Saturn can make <code>{managed?.path}</code> in the project with {tool}{record.tools.uv ? "" : " (install uv to pick a Python version and for faster installs)"}.</div>
                <form
                  className="lab-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(() => service.createEnvironment(projectId, { python: version.trim() || undefined, withCore }));
                  }}
                >
                  {record.tools.uv ? (
                    <label className="lab-field" style={{ maxWidth: 160 }}>
                      Python version
                      <input value={version} placeholder="3.12" onChange={(event) => setVersion(event.target.value)} />
                    </label>
                  ) : null}
                  <label className="lab-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={withCore} onChange={(event) => setWithCore(event.target.checked)} />
                    Also install what Saturn's helpers need (torch, transformers, numpy)
                  </label>
                  <button type="submit" className="lab-button primary" disabled={running}>
                    Create
                  </button>
                </form>
              </>
            ) : (
              <div className="lab-warning">Neither uv nor python3 is on this computer's PATH. Install uv (astral.sh/uv) or Python, then come back.</div>
            )}
          </div>
        )
      ) : null}

      {job ? (
        <div className={job.status === "failed" ? "lab-card attention" : "lab-card"} style={{ marginTop: 8 }}>
          <div className="lab-row">
            <span>
              <strong>{JOB_LABELS[job.kind]}</strong> <span className="lab-muted">{job.status === "running" ? "running" : job.status === "completed" ? "done" : job.status === "failed" ? `failed (exit ${job.exitCode ?? "?"})` : "interrupted: the runtime that started it is gone"}</span>
            </span>
            {running ? (
              <button type="button" className="lab-button" onClick={() => void act(() => service.stopEnvironmentJob(projectId))}>
                Stop
              </button>
            ) : (
              <span className="lab-muted">{new Date(job.endedAt ?? job.startedAt).toLocaleString()}</span>
            )}
          </div>
          <pre className="lab-text lab-terminal-log">{job.logTail || "Nothing written yet."}</pre>
          {job.logLines > 40 ? <div className="lab-muted">The last 40 of {job.logLines} lines; the whole log is in .saturn/research/environment-job.log.</div> : null}
        </div>
      ) : null}

      <h2>Kits</h2>
      <p className="lab-lead">Packages for one kind of work. Which are installed is read from the last check of the managed environment.</p>
      {record?.kits.map((kit: EnvironmentKit) => {
        const state = managed?.exists ? kitState(kit) : "missing";
        return (
          <div className="lab-row" key={kit.id}>
            <span>
              <strong>{kit.title}</strong>
              {kit.bundled ? <span className="lab-tag" style={{ marginLeft: 8 }}>Bundled</span> : null}
              <div className="lab-muted">{kit.what}</div>
              <div className="lab-muted">
                {kit.packages.map((item) => (
                  <span key={item.name} style={{ marginRight: 10 }}>
                    <code>{item.name}</code> {item.installed ? item.installed : <span className="lab-warning">not installed</span>}
                  </span>
                ))}
              </div>
            </span>
            {state === "installed" ? (
              <span className="lab-tag good">Installed</span>
            ) : (
              <button type="button" className="lab-button" disabled={running || !managed?.exists} title={managed?.exists ? undefined : "Create the managed environment first"} onClick={() => void act(() => service.installPackages(projectId, { kit: kit.id }))}>
                {state === "partly" ? "Install the rest" : "Install"}
              </button>
            )}
          </div>
        );
      })}

      <h2>Interpreter</h2>
      <form
        className="lab-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="lab-field" style={{ flex: "1 1 360px" }}>
          Python
          <input value={shown} placeholder=".venv/bin/python" spellCheck={false} onChange={(event) => setPython(event.target.value)} />
        </label>
        <button type="submit" className="lab-button" disabled={python === null}>
          Save
        </button>
        <button type="button" className="lab-button primary" disabled={checking || running || !shown.trim()} onClick={() => void check()}>
          {checking ? "Asking…" : "Check"}
        </button>
      </form>
      {!record?.python && record?.suggestedPython ? <p className="lab-muted">{managed?.exists && record.suggestedPython === managed.python ? "The managed environment." : "Taken from the newest experiment's command."} Save it to keep it.</p> : null}
      {record && !record.python && !record.suggestedPython ? <p className="lab-muted">Give the path of the Python that runs your experiments, start an experiment's command with it, or create the managed environment above.</p> : null}

      <h2>What it has</h2>
      {report ? (
        <>
          <div className="lab-stats">
            <div className="lab-stat"><span className="lab-muted">Python</span><strong>{report.version}</strong><span className="lab-muted">{report.executable}</span></div>
            <div className="lab-stat"><span className="lab-muted">Compute</span><strong>{devicesText(report)}</strong><span className="lab-muted">{report.cpus ?? "?"} CPUs · {report.platform}</span></div>
            <div className="lab-stat"><span className="lab-muted">Checked</span><strong>{record?.checkedAt ? new Date(record.checkedAt).toLocaleString() : ""}</strong><span className="lab-muted">with {record?.checkedWith}</span></div>
          </div>
          <div className="lab-table-wrap">
            <table className="lab-table">
              <thead>
                <tr><th scope="col">Package</th><th scope="col">Version</th></tr>
              </thead>
              <tbody>
                {Object.entries(report.packages).map(([name, installed]) => (
                  <tr key={name}>
                    <td><code>{name}</code></td>
                    <td>{installed ?? <span className="lab-muted">Not installed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="lab-muted">Not checked yet. Check asks the interpreter for its version, the packages research code leans on, and the devices torch can see.</p>
      )}

      <h2>What pins it</h2>
      {record && record.lockFiles.length === 0 ? <p className="lab-muted">No lock file at the project's root. A uv.lock, requirements.txt or pyproject.toml here would be listed with its hash, and can be made part of what a version freezes.</p> : null}
      {record?.lockFiles.map((file) => {
        const pinned = newest?.inputs?.environment?.includes(file.path);
        return (
          <div className="lab-row" key={file.path}>
            <span><code>{file.path}</code> <span className="lab-muted">{bytesText(file.size)} · {file.sha256.slice(0, 12)}</span></span>
            {newest ? (
              pinned ? (
                <span className="lab-tag good">Frozen with each version</span>
              ) : (
                <button type="button" className="lab-button" onClick={() => void pin(newest, file.path)}>
                  Freeze with versions of {newest.title}
                </button>
              )
            ) : null}
          </div>
        );
      })}
      <p className="lab-muted">A lock file frozen with a version makes a change to it a new version, so two runs with different environments never read as the same.</p>
    </Page>
  );
}
