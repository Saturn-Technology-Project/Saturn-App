import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import type { RunEvidence } from "../../domain/research.js";
import { Badge } from "../ui/base/Badge.js";
import { messageOf } from "../ui/Parts.js";

const MUTED = "text-xs text-muted-foreground";
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

/** A value the program reported, or "Unknown" when it did not. */
function reportedText(value: unknown): string {
  if (value === null || value === undefined) return t("Unknown (not reported)");
  return JSON.stringify(value);
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

  if (problem) return <div className="text-xs text-wait">{problem}</div>;
  if (!evidence) return <div className={MUTED}>{t("Loading…")}</div>;
  if (!evidence.recorded) return <div className={MUTED}>{t("This run was recorded before Saturn kept run evidence.")}</div>;

  const { expected, observed, reported, verdicts } = evidence;
  const snapshot = observed?.snapshot;
  const after = observed?.afterRun;
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
      {observed?.refused ? <div className="text-xs text-wait">{observed.refused}</div> : null}
      <div className="grid gap-3 md:grid-cols-3">
        <section>
          <div className={LABEL}>{t("Expected (the version)")}</div>
          <div className={MUTED}>{t("Command")}: <code>{expected?.command || "—"}</code></div>
          <div className={MUTED}>{t("Commit")}: <code>{expected?.commit?.slice(0, 12) ?? t("none")}</code></div>
          <div className={MUTED}>{t("Seeds")}: {expected?.seeds?.length ? expected.seeds.join(", ") : t("none")}</div>
        </section>
        <section>
          <div className={LABEL}>{t("Observed by Saturn")}</div>
          {snapshot ? (
            <>
              <div className={MUTED}>{t("{count} files in the run's snapshot", { count: snapshot.files.length })} · <code title={snapshot.manifestSha256}>{snapshot.manifestSha256.slice(0, 12)}</code></div>
              <div className={MUTED}>{t("Protected by read-only permissions, not isolated")}</div>
              {snapshot.inputs.map((input) => (
                <div key={input.path} className={MUTED}>
                  <code>{input.path}</code> · {howText(input.how)} · <code title={input.sha256}>{input.sha256.slice(0, 12)}</code>
                </div>
              ))}
              {snapshot.uncontrolled.length ? (
                <div className="text-xs text-wait">{t("Uncontrolled, reached by link: {paths}", { paths: snapshot.uncontrolled.map((item) => item.path).join(", ") })}</div>
              ) : null}
            </>
          ) : null}
          {observed?.seedsPassed?.length ? <div className={MUTED}>{t("Seeds passed as SATURN_RUN_SEED: {seeds}", { seeds: observed.seedsPassed.join(", ") })}</div> : null}
          {after?.changed?.length ? <div className="text-xs text-wait">{t("Changed during the run: {inputs}", { inputs: after.changed.join(", ") })}</div> : null}
          {after?.written?.length ? <div className={MUTED}>{t("{count} files written by the program, kept with the run", { count: after.written.length })}</div> : null}
        </section>
        <section>
          <div className={LABEL}>{t("Reported by the program")}</div>
          <div className={MUTED}>{t("Seed")}: {reportedText(reported?.seed)}</div>
          <div className={MUTED}>{t("Models")}: {reported?.models.length ? reported.models.map((model) => JSON.stringify(model)).join("; ") : t("Unknown (not reported)")}</div>
          <div className={MUTED}>{t("Resumed from")}: {reportedText(reported?.resume)}</div>
          {reported?.problems.length ? <div className="text-xs text-wait">{reported.problems.join(" ")}</div> : null}
        </section>
      </div>
      <p className="m-0 text-[11px] text-muted-foreground">{t("A hash confirms which content a file had. It does not show that the program used that content, or that the scorer or the conclusion is right.")}</p>
    </div>
  );
}
