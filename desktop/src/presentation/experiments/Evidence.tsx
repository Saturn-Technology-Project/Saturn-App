import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import { bytesText, durationText, type RunEvidence, type RunSandbox } from "../../domain/research.js";
import { Badge } from "../ui/base/Badge.js";
import { classes } from "../ui/base/classes.js";
import { messageOf } from "../ui/Parts.js";

const MUTED = "text-xs text-muted-foreground";
const WARNING = "text-xs text-wait";
const LABEL = "mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase";

/** The words and tone of each verdict, so none rests on its color. */
function verdict(axis: "execution" | "inputs" | "outputs", value: string): { text: string; tone: "good" | "wait" | "bad" | "neutral" } {
  if (axis === "execution") {
    if (value === "completed") return { text: t("Ran to completion"), tone: "good" };
    if (value === "running") return { text: t("Running"), tone: "neutral" };
    if (value === "not started") return { text: t("Not started"), tone: "bad" };
    return { text: t("Did not complete ({status})", { status: value }), tone: "bad" };
  }
  if (axis === "inputs") {
    if (value === "verified") return { text: t("All inputs verified"), tone: "good" };
    if (value === "partial") return { text: t("Inputs partly controlled"), tone: "wait" };
    if (value === "changed") return { text: t("Inputs changed"), tone: "bad" };
    return { text: t("Inputs not verified"), tone: "wait" };
  }
  if (value === "sealed") return { text: t("Outputs sealed"), tone: "good" };
  if (value === "changed") return { text: t("Outputs changed after sealing"), tone: "bad" };
  if (value === "incomplete") return { text: t("Outputs incomplete"), tone: "wait" };
  if (value === "pending") return { text: t("Outputs pending"), tone: "neutral" };
  return { text: t("No outputs"), tone: "wait" };
}

/** How a file got into the snapshot, in words. */
function howText(how: string): string {
  if (how === "from the commit") return t("from the commit");
  if (how === "saved copy") return t("from the saved copy");
  if (how === "linked") return t("linked, checked before and after");
  return t("copied");
}

/** What a model's revision pins, in words: a commit or hash fixes the weights, a name such as `main` can move. */
function revisionText(model: { weightsRevision: string | null; floating: boolean; revisionKind?: string }): string {
  const kind = model.revisionKind ?? (model.floating ? (model.weightsRevision ? "name" : "none") : "commit");
  if (kind === "commit") return t("pinned to commit {revision}", { revision: (model.weightsRevision ?? "").slice(0, 12) });
  if (kind === "hash") return t("pinned to hash {revision}", { revision: (model.weightsRevision ?? "").slice(0, 12) });
  if (kind === "name") return t("revision “{revision}” is a name, so it can come to mean other weights", { revision: model.weightsRevision ?? "" });
  return t("no revision, so the weights are not fixed");
}

/** How the run's program was confined, in a line, and whether that line is a warning. */
function sandboxLine(sandbox: RunSandbox | null | undefined, isolation: string | undefined): { text: string; warn: boolean } {
  if (!sandbox) {
    return isolation === "sandbox" ? { text: t("Isolated in the system sandbox"), warn: false } : { text: t("Protected by read-only permissions, not isolated"), warn: true };
  }
  if (sandbox.isolation === "sandbox") {
    const network = sandbox.network === "blocked" ? t("no network") : t("network allowed");
    return { text: t("Isolated by {mechanism}: read-only snapshot, {network}", { mechanism: sandbox.mechanism ?? "", network }), warn: false };
  }
  if (!sandbox.requested) return { text: t("Sandbox turned off for this version: the program could read and write anything this account can"), warn: true };
  return { text: t("Not isolated, this computer has no working sandbox: {reason}", { reason: sandbox.unavailable ?? "" }), warn: true };
}

/** Where the sandbox let the program write, and how much of the account it hid, in a line. */
function writableLine(sandbox: RunSandbox): string | null {
  if (!sandbox.writable) return null;
  const parts = [t("the run's records and output"), t("its own temporary folder")];
  if (sandbox.writable.caches.length) parts.push(t("{count} shared caches", { count: sandbox.writable.caches.length }));
  const hidden = sandbox.hidden?.length ? t("; {count} folders hidden", { count: sandbox.hidden.length }) : "";
  return t("Writable: {places}{hidden}", { places: parts.join(", "), hidden });
}

/** When the run went, and for how long: the start, the end and the time between, as far as they are known. */
function timeLine(startedAt: string | undefined, endedAt: string | undefined, exitCode: number | null | undefined): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : null;
  const when = end && !Number.isNaN(end.getTime()) && !Number.isNaN(start.getTime()) ? t("{start} to {end}, {duration}", { start: start.toLocaleString(), end: end.toLocaleTimeString(), duration: durationText(end.getTime() - start.getTime()) }) : t("Started {start}", { start: start.toLocaleString() });
  return exitCode === null || exitCode === undefined ? when : `${when} · ${t("exit code {code}", { code: exitCode })}`;
}

/** A reported seed as its value and where the program says it applied it, or "Unknown" when it did not report one. */
function seedText(seed: Record<string, unknown> | null | undefined): string {
  if (!seed) return t("Unknown (not reported)");
  const value = seed.value === undefined ? "?" : String(seed.value);
  const applied = Array.isArray(seed.applied) && seed.applied.length ? seed.applied.join(", ") : null;
  return applied ? t("{seed}, applied to {libraries}", { seed: value, libraries: applied }) : value;
}

/** A model the program says it loaded, as its source and the revision or hash it named, or as it wrote it. */
function modelText(model: Record<string, unknown>): string {
  const source = typeof model.source === "string" ? model.source : null;
  const pinned = [model.revision, model.commit, model.sha256].find((value) => typeof value === "string" && value) as string | undefined;
  if (!source) return JSON.stringify(model);
  return pinned ? `${source} @ ${pinned.length > 16 && /^[0-9a-f]+$/i.test(pinned) ? pinned.slice(0, 12) : pinned}` : source;
}

/** What the program says it restored on resuming, or "Unknown" when it did not say. */
function resumeText(resume: Record<string, unknown> | null | undefined): string {
  if (!resume) return t("Unknown (not reported)");
  const checkpoint = typeof resume.checkpoint === "string" ? resume.checkpoint : null;
  const restored = Array.isArray(resume.restored) && resume.restored.length ? resume.restored.join(", ") : null;
  if (checkpoint && restored) return t("{checkpoint}, restored {state}", { checkpoint, state: restored });
  if (checkpoint) return checkpoint;
  if (restored) return t("restored {state}", { state: restored });
  return JSON.stringify(resume);
}

/** The settings the program says it resolved, by name; the values are in the evidence file. */
function configText(config: Record<string, unknown> | null | undefined): string {
  if (!config) return t("Unknown (not reported)");
  const inner = config.resolved && typeof config.resolved === "object" ? (config.resolved as Record<string, unknown>) : config;
  const names = Object.keys(inner).filter((name) => name !== "kind");
  return names.length ? t("{count} settings reported: {names}", { count: names.length, names: names.join(", ") }) : t("reported, with no settings in it");
}

/** How many files a version names in each role, in a line. */
function inputsText(inputs: { code?: string[]; data?: string[]; scorer?: string[]; environment?: string[] } | null | undefined): string {
  const counts = [
    [inputs?.code?.length ?? 0, t("code")],
    [inputs?.data?.length ?? 0, t("data")],
    [inputs?.scorer?.length ?? 0, t("scorer")],
    [inputs?.environment?.length ?? 0, t("environment")],
  ] as const;
  const named = counts.filter(([count]) => count > 0).map(([count, role]) => `${count} ${role}`);
  return named.length ? named.join(", ") : t("none declared");
}

/**
 * A run's evidence in three columns: what the version expected, what Saturn observed, and what the program reported.
 * The verdicts say how far each goes, and the limits of hashes are always stated.
 */
export function Evidence(props: { projectId: string; runId: string }) {
  const [evidence, setEvidence] = useState<RunEvidence | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    desktop.research
      .evidence(props.projectId, props.runId)
      .then((found) => live && setEvidence(found))
      .catch((error: unknown) => live && setProblem(messageOf(error)));
    return () => {
      live = false;
    };
  }, [props.projectId, props.runId]);

  if (problem) return <div className={WARNING}>{problem}</div>;
  if (!evidence) return <div className={MUTED}>{t("Loading…")}</div>;
  if (!evidence.recorded) return <div className={MUTED}>{t("This run was recorded before Saturn kept run evidence.")}</div>;

  const { expected, observed, reported, verdicts, outputs } = evidence;
  const snapshot = observed?.snapshot;
  const after = observed?.afterRun;
  const confined = sandboxLine(observed?.sandbox, snapshot?.isolation);
  const writable = observed?.sandbox ? writableLine(observed.sandbox) : null;
  const environment = observed?.sandbox && typeof observed.sandbox.environment === "object" ? observed.sandbox.environment : null;
  const went = timeLine(observed?.startedAt, observed?.endedAt, observed?.exitCode);
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3" role="region" aria-label={t("Run evidence")}>
      {verdicts ? (
        <div className="flex flex-wrap gap-1.5">
          {(["execution", "inputs", "outputs"] as const).map((axis) => {
            const shown = verdict(axis, verdicts[axis]);
            return <Badge key={axis} tone={shown.tone}>{shown.text}</Badge>;
          })}
        </div>
      ) : null}
      {observed?.refused ? <div className={WARNING}>{observed.refused}</div> : null}
      <div className="grid gap-3 md:grid-cols-3">
        <section>
          <div className={LABEL}>{t("Expected (the version)")}</div>
          <div className={MUTED}>{t("Command")}: <code>{expected?.command || "—"}</code>{expected?.cwd && expected.cwd !== "." ? <> · {t("in {folder}", { folder: expected.cwd })}</> : null}</div>
          <div className={MUTED}>{t("Commit")}: <code>{expected?.commit?.slice(0, 12) ?? t("none")}</code></div>
          <div className={MUTED}>{t("Inputs")}: {inputsText(expected?.inputs)}</div>
          <div className={MUTED}>{t("Seeds")}: {expected?.seeds?.length ? expected.seeds.join(", ") : t("none")}</div>
          {expected?.models?.length ? (
            expected.models.map((model) => (
              <div key={`${model.modelId}-${model.role}`} className={classes(model.floating ? WARNING : MUTED, "wrap-anywhere")}>
                <code>{model.source}</code> ({model.role}) · {revisionText(model)}
              </div>
            ))
          ) : (
            <div className={MUTED}>{t("Models")}: {t("none")}</div>
          )}
          {expected?.resumeFrom ? <div className={MUTED}>{t("Resumes from")}: <code className="wrap-anywhere">{expected.resumeFrom}</code></div> : null}
        </section>
        <section>
          <div className={LABEL}>{t("Observed by Saturn")}</div>
          {observed?.executor === "ssh" ? (
            <div className={MUTED}>
              {t("On {host}, by its Saturn worker", { host: observed.host ?? "" })}
              {observed.workdir ? <> · <code className="wrap-anywhere">{observed.workdir}</code></> : null}
              {observed.system?.platform ? <> · {observed.system.platform}{observed.system.cpus ? t(", {count} CPUs", { count: observed.system.cpus }) : ""}</> : null}
            </div>
          ) : observed?.platform ? (
            <div className={MUTED}>{t("On this computer ({platform})", { platform: observed.platform })}</div>
          ) : null}
          {observed?.source?.gitCommit ? <div className={MUTED}>{t("The host's tree was at commit {commit}", { commit: observed.source.gitCommit.slice(0, 12) })}</div> : null}
          {went ? <div className={MUTED}>{went}</div> : null}
          {snapshot ? (
            <>
              <div className={MUTED}>{t("{count} files in the run's snapshot", { count: snapshot.files.length })} · <code title={snapshot.manifestSha256}>{snapshot.manifestSha256.slice(0, 12)}</code></div>
              <div className={confined.warn ? WARNING : MUTED}>{confined.text}</div>
              {writable ? <div className={MUTED}>{writable}</div> : null}
              {observed?.sandbox?.note ? <div className={MUTED}>{observed.sandbox.note}</div> : null}
              {environment ? (
                <div className={MUTED}>
                  {t("Environment variables it named: {names}", { names: environment.declared.filter((name) => environment.passed.includes(name)).join(", ") || t("none") })}
                  {environment.missing.length ? <span className="text-wait"> · {t("named but not set: {names}", { names: environment.missing.join(", ") })}</span> : null}
                  {environment.withheld ? <> · {t("{count} others withheld", { count: environment.withheld })}</> : null}
                </div>
              ) : null}
              {snapshot.inputs.map((input) => (
                <div key={input.path} className={MUTED}>
                  <code>{input.path}</code> · {howText(input.how)} · <code title={input.sha256}>{input.sha256.slice(0, 12)}</code>
                </div>
              ))}
              {snapshot.uncontrolled.length ? (
                <div className={WARNING}>{t("Uncontrolled, reached by link: {paths}", { paths: snapshot.uncontrolled.map((item) => item.path).join(", ") })}</div>
              ) : null}
            </>
          ) : null}
          {observed?.models?.map((model) => (
            <div key={model.modelId} className={model.weightsSha256 ? MUTED : WARNING}>
              <code>{model.source}</code> · {model.weightsSha256 ? <>{t("weights")} <code title={model.weightsSha256}>{model.weightsSha256.slice(0, 12)}</code></> : model.floating ? t("revision can change, weights not checked") : t("pinned revision, weights not checked here")}
            </div>
          ))}
          {observed?.seedsPassed?.length ? <div className={MUTED}>{t("Seeds passed as SATURN_RUN_SEED: {seeds}", { seeds: observed.seedsPassed.join(", ") })}</div> : null}
          {observed?.resume ? (
            <div className={MUTED}>
              {t("Took over from run {run}: {samples} samples, {metrics} metric lines", { run: observed.resume.run.slice(0, 8), samples: observed.resume.samples, metrics: observed.resume.metrics })}
              {observed.resume.checkpoint ? <> · {t("checkpoint {checkpoint}", { checkpoint: observed.resume.checkpoint })}{observed.resume.step !== null ? t(" at step {step}", { step: observed.resume.step }) : ""}</> : null}
            </div>
          ) : null}
          {after && !after.checked ? <div className={WARNING}>{t("Not checked after the run{reason}", { reason: after.reason ? `: ${after.reason}` : "" })}</div> : null}
          {after?.changed?.length ? <div className={WARNING}>{t("Changed during the run: {inputs}", { inputs: after.changed.join(", ") })}</div> : null}
          {after?.written?.length ? <div className={MUTED}>{t("{count} files written by the program, kept with the run", { count: after.written.length })}</div> : null}
          {after?.checked && after.kept === false ? <div className={MUTED}>{t("The snapshot was removed after the run; its list and hashes stay here.")}</div> : null}
        </section>
        <section>
          <div className={LABEL}>{t("Reported by the program")}</div>
          <div className={MUTED}>{t("Seed")}: {seedText(reported?.seed)}</div>
          <div className={MUTED}>{t("Models")}: {reported?.models.length ? null : t("Unknown (not reported)")}</div>
          {reported?.models.map((model, index) => (
            <div key={index} className={classes(MUTED, "wrap-anywhere")}>
              <code>{modelText(model)}</code>
            </div>
          ))}
          <div className={classes(MUTED, "wrap-anywhere")}>{t("Settings")}: {configText(reported?.config)}</div>
          <div className={classes(MUTED, "wrap-anywhere")}>{t("Resumed from")}: {resumeText(reported?.resume)}</div>
          {reported ? <div className={MUTED}>{reported.lines === 1 ? t("1 report line") : t("{count} report lines", { count: reported.lines })}</div> : null}
          {reported?.problems.length ? <div className={WARNING}>{reported.problems.join(" ")}</div> : null}
        </section>
      </div>
      {outputs?.samplesSha256 ? (
        <div className={MUTED}>
          {t("Sealed outputs")}: {t("{count} samples, {size}", { count: outputs.samples ?? 0, size: bytesText(outputs.samplesSize) })} · <code title={outputs.samplesSha256}>{outputs.samplesSha256.slice(0, 12)}</code>
        </div>
      ) : null}
      <p className="m-0 text-[11px] text-muted-foreground">{t("A hash confirms which content a file had. It does not show that the program used that content, or that the scorer or the conclusion is right.")}</p>
    </div>
  );
}
