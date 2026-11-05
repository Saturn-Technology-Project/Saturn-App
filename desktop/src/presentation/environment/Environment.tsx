import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { bytesText, devicesText, type ExperimentDraft } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

const service = desktop.research;

/** The Python the project's experiments run in: which one, what it has, and the files that pin it. */
export function Environment(props: ScreenProps) {
  const projectId = props.project.id;
  const { value, refresh } = useRecords(async () => ({ environment: await service.environment(projectId), drafts: (await service.experiments(projectId)).items }), props.notify);
  const [python, setPython] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const record = value?.environment ?? null;
  const shown = python ?? record?.python ?? record?.suggestedPython ?? "";

  async function save() {
    try {
      await service.setEnvironment(projectId, shown.trim());
      setPython(null);
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
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
    try {
      await service.updateExperiment(projectId, draft, { inputs: { ...draft.inputs, environment: [...current, path] } });
      await refresh();
    } catch (error) {
      props.notify(messageOf(error));
    }
  }

  const report = record?.report ?? null;
  const newest = value?.drafts.at(-1);

  return (
    <Page title="Environment" lead="Experiments and looking inside run with this Python. Saturn asks it what it has; it does not install anything.">
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
        <button type="button" className="lab-button primary" disabled={checking || !shown.trim()} onClick={() => void check()}>
          {checking ? "Asking…" : "Check"}
        </button>
      </form>
      {!record?.python && record?.suggestedPython ? <p className="lab-muted">Taken from the newest experiment's command. Save it to keep it.</p> : null}
      {record && !record.python && !record.suggestedPython ? <p className="lab-muted">Give the path of the Python that runs your experiments, or start an experiment's command with it.</p> : null}

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
                {Object.entries(report.packages).map(([name, version]) => (
                  <tr key={name}>
                    <td><code>{name}</code></td>
                    <td>{version ?? <span className="lab-muted">Not installed</span>}</td>
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
