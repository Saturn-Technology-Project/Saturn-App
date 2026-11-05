import { isBusy } from "../../domain/conversation.js";
import type { Run } from "../../domain/model.js";
import { shownInput, shownSources } from "../../domain/slash.js";
import { guideIn } from "../../domain/workbench.js";
import { FormattedOutput } from "../FormattedOutput.js";
import { RunChangesCard } from "../RunChanges.js";
import { RunSteps } from "../RunSteps.js";
import { startGuide } from "../shell/Guide.js";

/** One message and what came of it: its steps and approvals, its changes, and the answer. */
export function Turn(props: { run: Run; onComment?: (text: string) => void }) {
  const { run } = props;
  const details = [shownSources(run.input), run.mode === "ask" ? "Reads only" : ""].filter(Boolean).join(" · ");
  const guide = guideIn(run.output ?? "");
  return (
    <article className="lab-turn">
      <div className="lab-turn-input">
        <p>{shownInput(run.input)}</p>
        {details ? <div className="lab-turn-details" title={details}>{details}</div> : null}
      </div>
      <RunSteps run={run} busy={run.status === "running" || run.status === "queued"} />
      <RunChangesCard run={run} onComment={props.onComment} />
      {run.output ? (
        <div className="lab-turn-output">
          <FormattedOutput text={guide.text} />
          {guide.places.length ? (
            <button type="button" className="lab-button lab-turn-guide" title={guide.places.map((place) => place.title).join(", ")} onClick={() => startGuide(guide.places)}>
              {guide.places.length === 1 ? `Show me: ${guide.places[0].title}` : `Walk me through it (${guide.places.length} steps)`}
            </button>
          ) : null}
        </div>
      ) : isBusy(run) || run.status === "waiting_approval" ? null : (
        <div className={run.status === "failed" ? "lab-warning" : "lab-muted"}>{run.status === "cancelled" ? "Stopped" : run.error || run.status}</div>
      )}
    </article>
  );
}
