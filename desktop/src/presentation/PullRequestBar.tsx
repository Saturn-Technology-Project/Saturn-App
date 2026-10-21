import { useState } from "react";
import { desktop } from "../application/desktop";
import type { PullRequestWatch } from "../domain/model";

const CHECKS: Record<PullRequestWatch["checks"], { label: string; tone: string }> = {
  pending: { label: "Checks running", tone: "pending" },
  success: { label: "Checks passed", tone: "ok" },
  failure: { label: "Checks failed", tone: "failed" },
  none: { label: "No checks", tone: "pending" },
};

/**
 * The chat's pull request, followed after Saturn opened it: its checks (a failure goes back to the agent, at most
 * twice), and review comments the user can send to the agent or dismiss.
 */
export function PullRequestBar(props: { threadId: string; pr: PullRequestWatch; busy: boolean; onError: (message: string) => void }) {
  const { pr } = props;
  const [working, setWorking] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function act(key: string, action: () => Promise<unknown>) {
    setWorking(key);
    try {
      await action();
      props.onError("");
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Something went wrong");
    } finally {
      setWorking(null);
    }
  }

  const state = pr.state === "merged" ? { label: "Merged", tone: "ok" } : pr.state === "closed" ? { label: "Closed", tone: "pending" } : CHECKS[pr.checks];
  const fixing = Boolean(pr.fixRunId);
  return (
    <div className="pr-bar">
      <div className="pr-bar-row">
        <a className="pr-bar-link" href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number}</a>
        <span className={`pr-bar-state ${state.tone}`}>{state.label}</span>
        {pr.state === "open" && pr.checks === "failure" && pr.failed?.length ? <span className="pr-bar-detail">{pr.failed.map((run) => run.name).join(", ")}</span> : null}
        {fixing ? <span className="pr-bar-detail">Saturn asked the agent to fix them (round {pr.fixRounds} of 2); the fix is pushed when it finishes</span> : null}
        {!fixing && pr.state === "open" && pr.checks === "failure" && pr.fixRounds >= 2 ? <span className="pr-bar-detail">Still failing after 2 rounds: over to you</span> : null}
        {pr.error ? <span className="pr-bar-detail failed" title={pr.error}>{pr.error}</span> : null}
        <span className="pr-bar-spacer" />
        {pr.feedback.length ? (
          <button type="button" className="btn ghost tiny" onClick={() => setOpen((value) => !value)}>
            {pr.feedback.length} new comment{pr.feedback.length === 1 ? "" : "s"}
          </button>
        ) : null}
        {pr.state === "open" ? (
          <>
            <button type="button" className="btn ghost tiny" disabled={working !== null} onClick={() => void act("check", () => desktop.catalog.checkPullRequest(props.threadId))} title={pr.lastCheckedAt ? `Last looked at ${new Date(pr.lastCheckedAt).toLocaleTimeString()}; Saturn looks every 2 minutes` : "Look now"}>
              {working === "check" ? "Checking…" : "Check Now"}
            </button>
            <button type="button" className="btn ghost tiny" disabled={working !== null} onClick={() => void act("watch", () => desktop.catalog.watchPullRequest(props.threadId, !pr.watching))}>
              {pr.watching ? "Stop Following" : "Follow"}
            </button>
          </>
        ) : null}
      </div>
      {open && pr.feedback.length ? (
        <div className="pr-feedback">
          <ul>
            {pr.feedback.map((item) => (
              <li key={item.id}>
                <strong>{item.author}</strong>
                {item.path ? <code>{item.path}{item.line ? `:${item.line}` : ""}</code> : null}
                <span>{item.body}</span>
              </li>
            ))}
          </ul>
          <div className="pr-feedback-actions">
            <button type="button" className="btn ghost tiny" disabled={working !== null} onClick={() => void act("dismiss", () => desktop.catalog.dismissPullRequestFeedback(props.threadId))}>Dismiss</button>
            <button type="button" className="btn primary-btn tiny" disabled={working !== null || props.busy} title={props.busy ? "Wait for the agent to finish this turn" : "Send these comments to the agent as the next message"} onClick={() => void act("send", async () => { await desktop.catalog.sendPullRequestFeedback(props.threadId); setOpen(false); })}>
              Send to Agent
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
