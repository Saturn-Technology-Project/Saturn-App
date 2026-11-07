import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import { canResume, type ExperimentRun } from "../../domain/research.js";
import { Button } from "../ui/base/Button.js";
import { messageOf } from "../ui/Parts.js";

const service = desktop.research;

/** How long, in words, from seconds. */
function durationText(seconds: number): string {
  if (seconds < 60) return t("{count} s", { count: Math.round(seconds) });
  if (seconds < 3600) return t("{count} min", { count: Math.round(seconds / 60) });
  return t("{count} h", { count: (seconds / 3600).toFixed(1) });
}

/**
 * What can be done to a local run from its row: pause a running one and continue it, stop it, and resume one that
 * ended before its work was done with a new run of the same version. Remote runs keep their own stop request.
 */
export function RunControls(props: { projectId: string; run: ExperimentRun; changed: () => void; notify: (text: string) => void; compact?: boolean }) {
  const { projectId, run } = props;
  const [busy, setBusy] = useState(false);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      props.changed();
    } catch (error) {
      props.notify(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  const resumed = run.resumes && run.carried ? (
    <div className="text-muted-foreground">
      {run.carried.metrics
        ? t("Takes over from {run}: {count} training metrics up to step {step} came along.", { run: run.resumes, count: run.carried.metrics, step: run.carried.step ?? "?" })
        : t("Takes over from {run}: {count} finished samples came along.", { run: run.resumes, count: run.carried.samples })}
    </div>
  ) : null;
  const paused = run.pausedSeconds ? <span className="text-muted-foreground"> · {t("paused {time} in all", { time: durationText(run.pausedSeconds) })}</span> : null;
  if (run.remote || run.imported) return props.compact ? null : <>{resumed}</>;
  if (props.compact) {
    // In a bar: the buttons alone, for a run that is going; what it carried and how long it paused are on its row.
    return (
      <div className="flex flex-wrap gap-1">
        {run.status === "running" ? <Button variant="outline" size="small" disabled={busy} onClick={() => void act(() => service.pauseRun(projectId, run.id))}>{t("Pause")}</Button> : null}
        {run.status === "paused" ? <Button variant="outline" size="small" disabled={busy} onClick={() => void act(() => service.continueRun(projectId, run.id))}>{t("Continue")}</Button> : null}
        {run.status === "running" || run.status === "paused" ? <Button variant="outline" size="small" disabled={busy} onClick={() => void act(() => service.stopRun(projectId, run.id))}>{t("Stop")}</Button> : null}
      </div>
    );
  }
  return (
    <div className="my-1 flex flex-col gap-1">
      {resumed}
      {run.status === "paused" ? <div className="text-muted-foreground">{t("Paused. It keeps its memory, and the GPU's, until it is continued or stopped.")}{paused}</div> : null}
      <div className="flex flex-wrap gap-1">
        {run.status === "running" ? <Button variant="outline" size="small" disabled={busy} onClick={() => void act(() => service.pauseRun(projectId, run.id))}>{t("Pause")}</Button> : null}
        {run.status === "paused" ? <Button variant="outline" size="small" disabled={busy} onClick={() => void act(() => service.continueRun(projectId, run.id))}>{t("Continue")}</Button> : null}
        {run.status === "running" || run.status === "paused" ? <Button variant="outline" size="small" disabled={busy} onClick={() => void act(() => service.stopRun(projectId, run.id))}>{t("Stop")}</Button> : null}
        {canResume(run) ? <Button variant="outline" size="small" disabled={busy} title={t("Starts the same version again, keeping the samples this run finished, or from the last checkpoint it listed.")} onClick={() => void act(() => service.resumeRun(projectId, run.id, crypto.randomUUID()))}>{t("Resume")}</Button> : null}
      </div>
    </div>
  );
}
