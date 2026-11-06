import { isBusy } from "../../domain/conversation.js";
import { t } from "../../domain/i18n.js";
import type { Run } from "../../domain/model.js";
import { shownInput, shownSources } from "../../domain/slash.js";
import { guideIn } from "../../domain/workbench.js";
import { Button } from "../ui/base/Button.js";
import { FormattedOutput } from "../FormattedOutput.js";
import { RunChangesCard } from "../RunChanges.js";
import { RunSteps, WaitingSteps } from "../RunSteps.js";
import { shownPlace, startGuide } from "../shell/Guide.js";

/** One message and what came of it: its steps and approvals, its changes, and the answer. */
export function Turn(props: { run: Run; onComment?: (text: string) => void }) {
  const { run } = props;
  const details = [shownSources(run.input), run.mode === "ask" ? t("Reads only") : ""].filter(Boolean).join(" · ");
  const guide = guideIn(run.output ?? "");
  return (
    <article className="flex min-w-0 flex-none flex-col gap-2">
      <div className="flex max-w-[88%] min-w-0 flex-col gap-[3px] self-end rounded-[12px_12px_3px_12px] bg-primary/12 px-[11px] py-[7px] whitespace-pre-wrap [overflow-wrap:anywhere]">
        <p>{shownInput(run.input)}</p>
        {details ? <div className="truncate text-[11px] text-muted-foreground" title={details}>{details}</div> : null}
      </div>
      <RunSteps run={run} busy={run.status === "running" || run.status === "queued"} />
      <RunChangesCard run={run} onComment={props.onComment} />
      {run.output ? (
        <div className="min-w-0 leading-[1.55] [overflow-wrap:anywhere]">
          <FormattedOutput text={guide.text} />
          {guide.places.length ? (
            <Button variant="outline" className="mt-2" title={guide.places.map((place) => shownPlace(place).title).join(", ")} onClick={() => startGuide(guide.places)}>
              {guide.places.length === 1 ? t("Show me: {place}", { place: shownPlace(guide.places[0]).title }) : t("Walk me through it ({count} steps)", { count: guide.places.length })}
            </Button>
          ) : null}
        </div>
      ) : isBusy(run) || run.status === "waiting_approval" ? null : (
        <div className={run.status === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{run.status === "cancelled" ? t("Stopped") : run.error || run.status}</div>
      )}
      <WaitingSteps run={run} />
    </article>
  );
}
