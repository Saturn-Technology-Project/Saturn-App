import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { bytesText, devicesText, kitState, type EnvironmentKit, type ExperimentDraft } from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Heading, Row, Table } from "../home/Row.js";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { Checkbox } from "../ui/base/Checkbox.js";
import { classes } from "../ui/base/classes.js";
import { Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { messageOf, Page } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";
import { RemoteTargetEditor } from "./RemoteExecution.js";

const service = desktop.research;
const PANEL = "gap-0 border-0 bg-panel px-3.5 py-3";
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
  const [timeoutMinutes, setTimeoutMinutes] = useState("30");
  const timeoutSeconds = Number(timeoutMinutes) * 60;
  const timeoutValid = Number.isInteger(Number(timeoutMinutes)) && timeoutSeconds >= 60 && timeoutSeconds <= 86_400;
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
      <RemoteTargetEditor projectId={projectId} notify={props.notify} />
      <Heading data-tour="environment-managed">Managed environment</Heading>
      <Field label="Job timeout (minutes)" className="max-w-60">
        <Input type="number" min={1} max={1440} step={1} value={timeoutMinutes} onChange={(event) => setTimeoutMinutes(event.target.value)} />
        {!timeoutValid ? <span className="text-xs text-wait">Choose 1 to 1440 whole minutes.</span> : null}
      </Field>
      {record ? (
        managed?.exists ? (
          <Card className={PANEL}>
            <Row>
              <span>
                <code>{managed.path}</code> in the project{record.python === managed.python ? ", in use" : ""}
              </span>
              {record.python !== managed.python ? (
                <Button variant="outline" onClick={() => void act(() => service.setEnvironment(projectId, managed.python))}>
                  Use it
                </Button>
              ) : null}
              <Button variant="outline" disabled={running || !timeoutValid || !record.lockFiles.length} title={record.lockFiles.length ? "Brings it to what the lock file says" : "No lock file at the project's root"} onClick={() => void act(() => service.installPackages(projectId, { sync: true, timeoutSeconds }))}>
                Sync from lock file
              </Button>
            </Row>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const names = extra.split(/[\s,]+/).filter(Boolean);
                if (names.length) void act(() => service.installPackages(projectId, { packages: names, timeoutSeconds })).then(() => setExtra(""));
              }}
            >
              <Field label="Other packages" className="flex-[1_1_280px]">
                <Input value={extra} placeholder="rich scipy>=1.10" spellCheck={false} onChange={(event) => setExtra(event.target.value)} />
              </Field>
              <Button type="submit" variant="outline" disabled={running || !timeoutValid || !extra.trim()}>
                Install
              </Button>
            </form>
          </Card>
        ) : (
          <Card className={PANEL}>
            {tool ? (
              <>
                <div>No managed environment yet. Saturn can make <code>{managed?.path}</code> in the project with {tool}{record.tools.uv ? "" : " (install uv to pick a Python version and for faster installs)"}.</div>
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(() => service.createEnvironment(projectId, { python: version.trim() || undefined, withCore, timeoutSeconds }));
                  }}
                >
                  {record.tools.uv ? (
                    <Field label="Python version" className="max-w-40 flex-[1_1_160px]">
                      <Input value={version} placeholder="3.12" onChange={(event) => setVersion(event.target.value)} />
                    </Field>
                  ) : null}
                  <label className="flex min-w-0 flex-[1_1_160px] items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox checked={withCore} onCheckedChange={setWithCore} />
                    Also install what Saturn's helpers need (torch, transformers, numpy)
                  </label>
                  <Button type="submit" disabled={running || !timeoutValid}>
                    Create
                  </Button>
                </form>
              </>
            ) : (
              <div className="text-xs text-wait">Neither uv nor python3 is on this computer's PATH. Install uv (astral.sh/uv) or Python, then come back.</div>
            )}
          </Card>
        )
      ) : null}

      {job ? (
        <Card className={classes(PANEL, "mt-2", (job.status === "failed" || job.status === "timed_out") && "border border-wait")}>
          <Row>
            <span>
              <strong>{JOB_LABELS[job.kind]}</strong> <span className="text-xs text-muted-foreground">{job.status === "running" ? "running" : job.status === "completed" ? "done" : job.status === "timed_out" ? "timed out; processes stopped" : job.status === "failed" ? `failed (exit ${job.exitCode ?? "?"})` : "interrupted: the runtime that started it is gone"}</span>
            </span>
            {running ? (
              <Button variant="outline" onClick={() => void act(() => service.stopEnvironmentJob(projectId))}>
                Stop
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">{new Date(job.endedAt ?? job.startedAt).toLocaleString()}</span>
            )}
          </Row>
          {job.error ? <div className="text-xs text-wait">{job.error}</div> : null}
          {job.status === "running" && job.timeoutSeconds ? <div className="text-xs text-muted-foreground">Stops after {job.timeoutSeconds / 60} minutes. You can stop it sooner.</div> : null}
          <pre className="overflow-auto px-2.5 py-2 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{job.logTail || "Nothing written yet."}</pre>
          {job.logLines > 40 ? <div className="text-xs text-muted-foreground">The last 40 of {job.logLines} lines; the whole log is in .saturn/research/environment-job.log.</div> : null}
        </Card>
      ) : null}

      <Heading data-tour="environment-kits">Kits</Heading>
      <p className="max-w-[680px] text-muted-foreground">Packages for one kind of work. Which are installed is read from the last check of the managed environment.</p>
      {record?.kits.map((kit: EnvironmentKit) => {
        const state = managed?.exists ? kitState(kit) : "missing";
        return (
          <Row key={kit.id}>
            <span>
              <strong>{kit.title}</strong>
              {kit.bundled ? <Badge className="ml-2">Bundled</Badge> : null}
              <div className="text-xs text-muted-foreground">{kit.what}</div>
              <div className="text-xs text-muted-foreground">
                {kit.packages.map((item) => (
                  <span key={item.name} style={{ marginRight: 10 }}>
                    <code>{item.name}</code> {item.installed ? item.installed : <span className="text-xs text-wait">not installed</span>}
                  </span>
                ))}
              </div>
            </span>
            {state === "installed" ? (
              <Badge tone="good">Installed</Badge>
            ) : (
              <Button variant="outline" disabled={running || !timeoutValid || !managed?.exists} title={managed?.exists ? undefined : "Create the managed environment first"} onClick={() => void act(() => service.installPackages(projectId, { kit: kit.id, timeoutSeconds }))}>
                {state === "partly" ? "Install the rest" : "Install"}
              </Button>
            )}
          </Row>
        );
      })}

      <Heading data-tour="environment-interpreter">Interpreter</Heading>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Python" className="flex-[1_1_360px]">
          <Input value={shown} placeholder=".venv/bin/python" spellCheck={false} onChange={(event) => setPython(event.target.value)} />
        </Field>
        <Button type="submit" variant="outline" disabled={python === null}>
          Save
        </Button>
        <Button disabled={checking || running || !shown.trim()} onClick={() => void check()}>
          {checking ? "Asking…" : "Check"}
        </Button>
      </form>
      {!record?.python && record?.suggestedPython ? <p className="text-xs text-muted-foreground">{managed?.exists && record.suggestedPython === managed.python ? "The managed environment." : "Taken from the newest experiment's command."} Save it to keep it.</p> : null}
      {record && !record.python && !record.suggestedPython ? <p className="text-xs text-muted-foreground">Give the path of the Python that runs your experiments, start an experiment's command with it, or create the managed environment above.</p> : null}

      <Heading>What it has</Heading>
      {report ? (
        <>
          <div className="mt-3 mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            <div className="flex flex-col gap-0.5 rounded-md bg-panel px-3 py-2.5 text-xs"><span className="text-xs text-muted-foreground">Python</span><strong>{report.version}</strong><span className="text-xs text-muted-foreground">{report.executable}</span></div>
            <div className="flex flex-col gap-0.5 rounded-md bg-panel px-3 py-2.5 text-xs"><span className="text-xs text-muted-foreground">Compute</span><strong>{devicesText(report)}</strong><span className="text-xs text-muted-foreground">{report.cpus ?? "?"} CPUs · {report.platform}</span></div>
            <div className="flex flex-col gap-0.5 rounded-md bg-panel px-3 py-2.5 text-xs"><span className="text-xs text-muted-foreground">Checked</span><strong>{record?.checkedAt ? new Date(record.checkedAt).toLocaleString() : ""}</strong><span className="text-xs text-muted-foreground">with {record?.checkedWith}</span></div>
          </div>
          <Table label="Packages and their versions">
            <thead>
              <tr><th scope="col">Package</th><th scope="col">Version</th></tr>
            </thead>
            <tbody>
              {Object.entries(report.packages).map(([name, installed]) => (
                <tr key={name}>
                  <td><code>{name}</code></td>
                  <td>{installed ?? <span className="text-xs text-muted-foreground">Not installed</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Not checked yet. Check asks the interpreter for its version, the packages research code leans on, and the devices torch can see.</p>
      )}

      <Heading data-tour="environment-locks">What pins it</Heading>
      {record && record.lockFiles.length === 0 ? <p className="text-xs text-muted-foreground">No lock file at the project's root. A uv.lock, requirements.txt or pyproject.toml here would be listed with its hash, and can be made part of what a version freezes.</p> : null}
      {record?.lockFiles.map((file) => {
        const pinned = newest?.inputs?.environment?.includes(file.path);
        return (
          <Row key={file.path}>
            <span><code>{file.path}</code> <span className="text-xs text-muted-foreground">{bytesText(file.size)} · {file.sha256.slice(0, 12)}</span></span>
            {newest ? (
              pinned ? (
                <Badge tone="good">Frozen with each version</Badge>
              ) : (
                <Button variant="outline" onClick={() => void pin(newest, file.path)}>
                  Freeze with versions of {newest.title}
                </Button>
              )
            ) : null}
          </Row>
        );
      })}
      <p className="text-xs text-muted-foreground">A lock file frozen with a version makes a change to it a new version, so two runs with different environments never read as the same.</p>
    </Page>
  );
}
