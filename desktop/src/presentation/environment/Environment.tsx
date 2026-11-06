import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
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
const JOB_LABELS = { create: t("Making the environment"), install: t("Installing"), sync: t("Syncing from the lock file") } as const;


/** The runtime's package kits in the interface's language, by id; a kit not listed here shows the runtime's English. */
const KIT_TEXT: Record<string, { title: string; what: string }> = {
  core: { title: t("What Saturn's helpers need"), what: t("Looking inside a model and the environment check load models with these. Installed with the environment unless you say not to.") },
  interpretability: { title: t("Interpretability"), what: t("TransformerLens for hooks and patching, SAELens for sparse autoencoders, einops for the tensor shapes.") },
  training: { title: t("Post-training"), what: t("TRL for SFT and DPO, PEFT for adapters, datasets and accelerate underneath them.") },
  analysis: { title: t("Analysis"), what: t("pandas and matplotlib for tables and figures from a run's samples.") },
  notebooks: { title: t("Notebooks"), what: t("Jupyter and a kernel, for notebooks beside the code.") },
};

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
    <Page title={t("Environment")} lead={t("Experiments and looking inside run with this Python. Saturn can make one in the project and fill it with what the work needs; it installs nothing you did not ask for.")}>
      <RemoteTargetEditor projectId={projectId} notify={props.notify} />
      <Heading data-tour="environment-managed">{t("Managed environment")}</Heading>
      <Field label={t("Job timeout (minutes)")} className="max-w-60">
        <Input type="number" min={1} max={1440} step={1} value={timeoutMinutes} onChange={(event) => setTimeoutMinutes(event.target.value)} />
        {!timeoutValid ? <span className="text-xs text-wait">{t("Choose 1 to 1440 whole minutes.")}</span> : null}
      </Field>
      {record ? (
        managed?.exists ? (
          <Card className={PANEL}>
            <Row>
              <span>
                <code>{managed.path}</code> {record.python === managed.python ? t("in the project, in use") : t("in the project")}
              </span>
              {record.python !== managed.python ? (
                <Button variant="outline" onClick={() => void act(() => service.setEnvironment(projectId, managed.python))}>
                  {t("Use it")}
                </Button>
              ) : null}
              <Button variant="outline" disabled={running || !timeoutValid || !record.lockFiles.length} title={record.lockFiles.length ? t("Brings it to what the lock file says") : t("No lock file at the project's root")} onClick={() => void act(() => service.installPackages(projectId, { sync: true, timeoutSeconds }))}>
                {t("Sync from lock file")}
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
              <Field label={t("Other packages")} className="flex-[1_1_280px]">
                <Input value={extra} placeholder="rich scipy>=1.10" spellCheck={false} onChange={(event) => setExtra(event.target.value)} />
              </Field>
              <Button type="submit" variant="outline" disabled={running || !timeoutValid || !extra.trim()}>
                {t("Install")}
              </Button>
            </form>
          </Card>
        ) : (
          <Card className={PANEL}>
            {tool ? (
              <>
                <div>
                  {t("No managed environment yet. Saturn can make one in the project with {tool}:", { tool })} <code>{managed?.path}</code>
                  {record.tools.uv ? null : <> {t("Install uv to pick a Python version and for faster installs.")}</>}
                </div>
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(() => service.createEnvironment(projectId, { python: version.trim() || undefined, withCore, timeoutSeconds }));
                  }}
                >
                  {record.tools.uv ? (
                    <Field label={t("Python version")} className="max-w-40 flex-[1_1_160px]">
                      <Input value={version} placeholder="3.12" onChange={(event) => setVersion(event.target.value)} />
                    </Field>
                  ) : null}
                  <label className="flex min-w-0 flex-[1_1_160px] items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox checked={withCore} onCheckedChange={setWithCore} />
                    {t("Also install what Saturn's helpers need (torch, transformers, numpy)")}
                  </label>
                  <Button type="submit" disabled={running || !timeoutValid}>
                    {t("Create")}
                  </Button>
                </form>
              </>
            ) : (
              <div className="text-xs text-wait">{t("Neither uv nor python3 is on this computer's PATH. Install uv (astral.sh/uv) or Python, then come back.")}</div>
            )}
          </Card>
        )
      ) : null}

      {job ? (
        <Card className={classes(PANEL, "mt-2", (job.status === "failed" || job.status === "timed_out") && "border border-wait")}>
          <Row>
            <span>
              <strong>{JOB_LABELS[job.kind]}</strong> <span className="text-xs text-muted-foreground">{job.status === "running" ? t("running") : job.status === "completed" ? t("done") : job.status === "timed_out" ? t("timed out; processes stopped") : job.status === "failed" ? t("failed (exit {code})", { code: job.exitCode ?? "?" }) : t("interrupted: the runtime that started it is gone")}</span>
            </span>
            {running ? (
              <Button variant="outline" onClick={() => void act(() => service.stopEnvironmentJob(projectId))}>
                {t("Stop")}
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">{new Date(job.endedAt ?? job.startedAt).toLocaleString()}</span>
            )}
          </Row>
          {job.error ? <div className="text-xs text-wait">{job.error}</div> : null}
          {job.status === "running" && job.timeoutSeconds ? <div className="text-xs text-muted-foreground">{t("Stops after {minutes} minutes. You can stop it sooner.", { minutes: job.timeoutSeconds / 60 })}</div> : null}
          <pre className="overflow-auto px-2.5 py-2 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{job.logTail || t("Nothing written yet.")}</pre>
          {job.logLines > 40 ? <div className="text-xs text-muted-foreground">{t("The last 40 of {count} lines; the whole log is in {path}.", { count: job.logLines, path: ".saturn/research/environment-job.log" })}</div> : null}
        </Card>
      ) : null}

      <Heading data-tour="environment-kits">{t("Kits")}</Heading>
      <p className="max-w-[680px] text-muted-foreground">{t("Packages for one kind of work. Which are installed is read from the last check of the managed environment.")}</p>
      {record?.kits.map((kit: EnvironmentKit) => {
        const state = managed?.exists ? kitState(kit) : "missing";
        return (
          <Row key={kit.id}>
            <span>
              <strong>{KIT_TEXT[kit.id]?.title ?? kit.title}</strong>
              {kit.bundled ? <Badge className="ml-2">{t("Bundled")}</Badge> : null}
              <div className="text-xs text-muted-foreground">{KIT_TEXT[kit.id]?.what ?? kit.what}</div>
              <div className="text-xs text-muted-foreground">
                {kit.packages.map((item) => (
                  <span key={item.name} style={{ marginRight: 10 }}>
                    <code>{item.name}</code> {item.installed ? item.installed : <span className="text-xs text-wait">{t("not installed")}</span>}
                  </span>
                ))}
              </div>
            </span>
            {state === "installed" ? (
              <Badge tone="good">{t("Installed")}</Badge>
            ) : (
              <Button variant="outline" disabled={running || !timeoutValid || !managed?.exists} title={managed?.exists ? undefined : t("Create the managed environment first")} onClick={() => void act(() => service.installPackages(projectId, { kit: kit.id, timeoutSeconds }))}>
                {state === "partly" ? t("Install the rest") : t("Install")}
              </Button>
            )}
          </Row>
        );
      })}

      <Heading data-tour="environment-interpreter">{t("Interpreter")}</Heading>
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
          {t("Save")}
        </Button>
        <Button disabled={checking || running || !shown.trim()} onClick={() => void check()}>
          {checking ? t("Asking…") : t("Check")}
        </Button>
      </form>
      {!record?.python && record?.suggestedPython ? <p className="text-xs text-muted-foreground">{managed?.exists && record.suggestedPython === managed.python ? t("The managed environment. Save it to keep it.") : t("Taken from the newest experiment's command. Save it to keep it.")}</p> : null}
      {record && !record.python && !record.suggestedPython ? <p className="text-xs text-muted-foreground">{t("Give the path of the Python that runs your experiments, start an experiment's command with it, or create the managed environment above.")}</p> : null}

      <Heading>{t("What it has")}</Heading>
      {report ? (
        <>
          <div className="mt-3 mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            <div className="flex flex-col gap-0.5 rounded-md bg-panel px-3 py-2.5 text-xs"><span className="text-xs text-muted-foreground">Python</span><strong>{report.version}</strong><span className="text-xs text-muted-foreground">{report.executable}</span></div>
            <div className="flex flex-col gap-0.5 rounded-md bg-panel px-3 py-2.5 text-xs"><span className="text-xs text-muted-foreground">{t("Compute")}</span><strong>{devicesText(report)}</strong><span className="text-xs text-muted-foreground">{t("{count} CPUs", { count: report.cpus ?? "?" })} · {report.platform}</span></div>
            <div className="flex flex-col gap-0.5 rounded-md bg-panel px-3 py-2.5 text-xs"><span className="text-xs text-muted-foreground">{t("Checked")}</span><strong>{record?.checkedAt ? new Date(record.checkedAt).toLocaleString() : ""}</strong><span className="text-xs text-muted-foreground">{t("with {python}", { python: record?.checkedWith ?? "" })}</span></div>
          </div>
          <Table label={t("Packages and their versions")}>
            <thead>
              <tr><th scope="col">{t("Package")}</th><th scope="col">{t("Version")}</th></tr>
            </thead>
            <tbody>
              {Object.entries(report.packages).map(([name, installed]) => (
                <tr key={name}>
                  <td><code>{name}</code></td>
                  <td>{installed ?? <span className="text-xs text-muted-foreground">{t("Not installed")}</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t("Not checked yet. Check asks the interpreter for its version, the packages research code leans on, and the devices torch can see.")}</p>
      )}

      <Heading data-tour="environment-locks">{t("What pins it")}</Heading>
      {record && record.lockFiles.length === 0 ? <p className="text-xs text-muted-foreground">{t("No lock file at the project's root. A uv.lock, requirements.txt or pyproject.toml here would be listed with its hash, and can be made part of what a version freezes.")}</p> : null}
      {record?.lockFiles.map((file) => {
        const pinned = newest?.inputs?.environment?.includes(file.path);
        return (
          <Row key={file.path}>
            <span><code>{file.path}</code> <span className="text-xs text-muted-foreground">{bytesText(file.size)} · {file.sha256.slice(0, 12)}</span></span>
            {newest ? (
              pinned ? (
                <Badge tone="good">{t("Frozen with each version")}</Badge>
              ) : (
                <Button variant="outline" onClick={() => void pin(newest, file.path)}>
                  {t("Freeze with versions of {experiment}", { experiment: newest.title })}
                </Button>
              )
            ) : null}
          </Row>
        );
      })}
      <p className="text-xs text-muted-foreground">{t("A lock file frozen with a version makes a change to it a new version, so two runs with different environments never read as the same.")}</p>
    </Page>
  );
}
