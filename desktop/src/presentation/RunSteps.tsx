import { useState, type ReactNode } from "react";
import {
  actionLine,
  formatDuration,
  formatPayload,
  runSteps,
  type ActionLine,
  type RunStep,
} from "../domain/conversation";
import type { Run, RunAction, RunThought } from "../domain/model";
import { desktop } from "../application/desktop";
import { RecordingPlayer } from "./RecordingPlayer";
import { activateOnKey } from "./keyboard";
import { SCOPE_CHOICES } from "./Permissions";
import { suggestedPattern } from "../domain/permissions";
import type { PermissionScope } from "../domain/model";

/**
 * A run's work as a quiet Antigravity-style list: "Thought for 13s ›" rows between one-line tool
 * calls ("Analyzed TS mcp.ts#L1-73"), under a collapsible header, with "Working" while it runs.
 */
export function RunSteps(props: { run: Run; busy: boolean; nested?: boolean }) {
  const { run, busy } = props;
  const steps = runSteps(run);
  const [override, setOverride] = useState<boolean | null>(null);
  if (!steps.length && !busy) return null;
  if (!steps.length) {
    return (
      <div className="run-steps">
        <WorkingRow />
      </div>
    );
  }
  const open = override ?? (busy || !run.output);

  return (
    <div className={props.nested ? "run-steps nested" : "run-steps"}>
      <button type="button" className="run-steps-head" onClick={() => setOverride(!open)} aria-expanded={open}>
        <span className="run-steps-title">{busy ? currentLabel(steps) : doneLabel(steps)}</span>
        <Chevron down={open} />
      </button>
      {open ? (
        <div className="run-steps-list">
          {steps.map((step) =>
            step.kind === "thought" ? (
              <ThoughtRow key={step.key} thought={step.thought} />
            ) : (
              <ActionRow key={step.key} runId={run.id} action={step.action} restorable={!busy && Boolean(run.checkpoint?.steps?.some((entry) => entry.actionId === step.action.id))}>
                {step.action.toolId === "delegate" && run.children?.length ? <SubAgentRuns runs={run.children} /> : null}
              </ActionRow>
            ),
          )}
          {busy ? <WorkingRow /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The sub-agent runs a delegate step started: each one's task, state and its own steps, nested under the step. */
function SubAgentRuns(props: { runs: Run[] }) {
  return (
    <div className="sub-agent-runs">
      {props.runs.map((child) => {
        const busy = child.status === "running" || child.status === "queued" || child.status === "waiting_approval" || child.status === "sleeping";
        const state = child.status === "waiting_approval" ? "needs your approval" : child.status === "completed" ? "done" : child.status === "failed" ? "failed" : child.status === "cancelled" ? "stopped" : "working";
        return (
          <div className={`sub-agent-run ${child.status}`} key={child.id}>
            <div className="sub-agent-head">
              <span className="sub-agent-badge">{child.delegated?.tools === "all" ? "sub-agent" : "sub-agent · read-only"}</span>
              <span className="sub-agent-task" title={child.delegated?.task ?? child.input}>{child.delegated?.task ?? child.input}</span>
              <span className={`sub-agent-state ${child.status}`}>{state}</span>
            </div>
            <RunSteps run={child} busy={busy} nested />
            {child.output ? <div className="sub-agent-answer">{child.output}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function ThoughtRow(props: { thought: RunThought }) {
  const [open, setOpen] = useState(false);
  const { thought } = props;
  return (
    <div className="step-row-wrap">
      <button type="button" className="step-row step-thought" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="step-verb">{thought.seconds > 0 ? `Thought for ${formatDuration(thought.seconds)}` : "Thought"}</span>
        <Chevron down={open} />
      </button>
      {open ? (
        <div className="step-thought-body">
          <ThoughtText text={thought.text} />
        </div>
      ) : null}
    </div>
  );
}

function getScreenshotImage(action: RunAction): string | null {
  if (action.toolId !== "computer_screenshot" && !action.toolId.includes("screenshot")) {
    return null;
  }
  const result: unknown = action.result;
  if (!result) return null;
  if (typeof result === "string") return result.startsWith("data:image/") ? result : null;
  const res = result as Record<string, unknown>;
  if (typeof res.image === "string" && res.image.startsWith("data:image/")) return res.image;
  if (typeof res.screenshot === "string" && res.screenshot.startsWith("data:image/")) return res.screenshot;
  if (typeof res.base64 === "string" && res.base64) {
    return res.base64.startsWith("data:") ? res.base64 : `data:image/jpeg;base64,${res.base64}`;
  }
  return null;
}

/** A finished browser recording in a step's result, for the player. */
function getRecording(action: RunAction): { name: string; frames: number; seconds?: number } | null {
  if (action.toolId !== "browser_record_stop" || action.status !== "completed") return null;
  const result = action.result as { recording?: unknown; frames?: unknown; seconds?: unknown } | undefined;
  if (!result || typeof result.recording !== "string" || typeof result.frames !== "number" || result.frames < 1) return null;
  return { name: result.recording.split(/[/\\]/).pop() || "", frames: result.frames, ...(typeof result.seconds === "number" ? { seconds: result.seconds } : {}) };
}

function sanitizeResultForDisplay(val: unknown): unknown {
  if (!val || typeof val !== "object") return val;
  const clone = { ...(val as Record<string, unknown>) };
  if (typeof clone.image === "string" && clone.image.startsWith("data:image/")) {
    clone.image = "[screenshot image shown above]";
  }
  if (typeof clone.screenshot === "string" && clone.screenshot.startsWith("data:image/")) {
    clone.screenshot = "[screenshot image shown above]";
  }
  if (typeof clone.base64 === "string") {
    clone.base64 = "[screenshot image shown above]";
  }
  return clone;
}

function ActionRow(props: { runId: string; action: RunAction; restorable?: boolean; children?: ReactNode }) {
  // Only an action with an id can be answered.
  const waiting = props.action.status === "waiting_approval" && Boolean(props.action.id);
  const [open, setOpen] = useState(waiting);
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const { action } = props;
  const line = actionLine(action);
  const screenshotImg = getScreenshotImage(action);
  const recording = getRecording(action);
  const argsText = action.arguments && Object.keys(action.arguments).length > 0 ? formatPayload(action.arguments) : "";
  const resultText = action.reason || formatPayload(sanitizeResultForDisplay(action.result));
  const hasDetails = Boolean(argsText || resultText);
  const state = statusTag(action.status, action.reason);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // "Always allow": a rule for this tool, offered as a prefix of what it asked for.
  const [always, setAlways] = useState(false);
  const [pattern, setPattern] = useState(() => suggestedPattern(props.action.toolId, props.action.arguments ?? {}));
  const [scope, setScope] = useState<PermissionScope>("project");

  async function allowAlways() {
    setDeciding(true);
    setDecisionError("");
    try {
      if (action.id) await desktop.runs.allowAlways(props.runId, action.id, { scope, pattern });
    } catch (reason) {
      setDecisionError(reason instanceof Error ? reason.message : "Could not save the rule");
      setDeciding(false);
    }
  }

  async function restoreHere() {
    setRestoring(true);
    try {
      const result = await desktop.runs.restoreTo(props.runId, action.id);
      setDecisionError(result.files.length ? "" : "Nothing to restore.");
      window.dispatchEvent(new Event("saturn:changes"));
    } catch (reason) {
      setDecisionError(reason instanceof Error ? reason.message : "Could not restore");
    } finally {
      setRestoring(false);
      setConfirmRestore(false);
    }
  }

  async function decide(allow: boolean) {
    setDeciding(true);
    setDecisionError("");
    try {
      if (action.id) await desktop.runs.decide(props.runId, action.id, allow);
    } catch (reason) {
      setDecisionError(reason instanceof Error ? reason.message : "Could not send your answer");
      setDeciding(false);
    }
  }

  return (
    <div className="step-row-wrap">
      <button
        type="button"
        className={`step-row step-action${state ? ` ${state.tone}` : ""}`}
        onClick={() => hasDetails && setOpen((value) => !value)}
        aria-expanded={hasDetails ? open : undefined}
        title={action.toolId}
      >
        <span className="step-verb">{line.verb}</span>
        <ActionTarget line={line} />
        {state ? <span className={`step-state ${state.tone}`}>{state.label}</span> : null}
        {hasDetails ? <Chevron down={open} subtle /> : null}
      </button>
      {props.restorable ? (
        confirmRestore ? (
          <span className="step-restore-confirm">
            <span>Put the files back to just before this step? Later steps and turns are undone too.</span>
            <button type="button" className="changes-btn danger" disabled={restoring} onClick={() => void restoreHere()}>Restore</button>
            <button type="button" className="changes-btn" disabled={restoring} onClick={() => setConfirmRestore(false)}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="step-restore" title="Put the files back to how they were just before this step" onClick={() => setConfirmRestore(true)}>
            Restore to here
          </button>
        )
      ) : null}

      {waiting ? (
        <div className="step-approval" role="group" aria-label={`Approve ${action.toolId}?`}>
          <span className="step-approval-text">Allow {action.toolId} to run?</span>
          {decisionError ? <span className="step-approval-error">{decisionError}</span> : null}
          <button
            type="button"
            className="btn ghost tiny"
            disabled={deciding}
            onClick={() => void decide(false)}
          >
            Deny
          </button>
          <button type="button" className="btn primary-btn tiny" disabled={deciding} onClick={() => void decide(true)}>
            Approve
          </button>
          {always ? (
            <form className="step-always" onSubmit={(event) => { event.preventDefault(); void allowAlways(); }}>
              <span className="step-always-text">Allow <code>{action.toolId}</code> matching</span>
              <input className="input tiny" aria-label="Rule pattern" value={pattern} onChange={(event) => setPattern(event.target.value)} />
              <span className="step-always-text">in</span>
              <select className="input tiny settings-select-fit" aria-label="Where the rule applies" value={scope} onChange={(event) => setScope(event.target.value as PermissionScope)}>
                {SCOPE_CHOICES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              <button type="submit" className="btn tiny" disabled={deciding || !pattern.trim()}>Save and approve</button>
              <button type="button" className="btn ghost tiny" disabled={deciding} onClick={() => setAlways(false)}>Cancel</button>
            </form>
          ) : (
            <button type="button" className="btn ghost tiny" disabled={deciding} onClick={() => setAlways(true)} title="Save a rule so calls like this one run without asking">
              Always allow…
            </button>
          )}
        </div>
      ) : null}

      {props.children}

      {/* Screenshot displayed right below Called computer_screenshot */}
      {recording ? <RecordingPlayer runId={props.runId} name={recording.name} frames={recording.frames} seconds={recording.seconds} /> : null}
      {screenshotImg ? (
        <div className="step-screenshot-container">
          <div
            className="step-screenshot-wrap"
            role="button"
            tabIndex={0}
            aria-label="View full screenshot"
            onKeyDown={activateOnKey}
            onClick={() => setModalOpen(true)}
            title="Click to view full screenshot"
          >
            <img
              src={screenshotImg}
              alt="Computer Screenshot"
              className="step-screenshot-img"
              loading="lazy"
            />
            <span className="step-screenshot-badge">🔍 Zoom</span>
          </div>
        </div>
      ) : null}

      {modalOpen && screenshotImg ? (
        <div className="screenshot-lightbox" onClick={() => setModalOpen(false)}>
          <div className="screenshot-lightbox-content" role="dialog" aria-modal="true" aria-label="Screenshot" onClick={(e) => e.stopPropagation()}>
            <img src={screenshotImg} alt="Screenshot full view" />
            <button
              type="button"
              className="screenshot-lightbox-close"
              aria-label="Close screenshot"
              onClick={() => setModalOpen(false)}
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {open && hasDetails ? (
        <div className="step-details">
          {argsText ? (
            <div className="step-detail-block">
              <div className="step-detail-label">Arguments</div>
              <pre>{argsText}</pre>
            </div>
          ) : null}
          {resultText ? (
            <div className="step-detail-block">
              <div className="step-detail-label">{action.reason ? "Reason" : "Result"}</div>
              <pre>{resultText}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ActionTarget(props: { line: ActionLine }) {
  const { line } = props;
  if (!line.target) return null;
  return (
    <span className="step-target">
      {line.badge ? <span className="step-file-badge">{line.badge}</span> : null}
      <span className={line.mono ? "step-target-text mono" : "step-target-text"}>{line.target}</span>
      {line.suffix ? <span className="step-suffix">{line.suffix}</span> : null}
    </span>
  );
}

function WorkingRow() {
  return <div className="step-working">Working</div>;
}

/** Plain reasoning text: blank-line paragraphs, "**Heading**" lines, inline **bold** and `code`. */
function ThoughtText(props: { text: string }) {
  const paragraphs = props.text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const heading = paragraph.match(/^\*\*(.+?)\*\*$/);
        if (heading) return <p key={index} className="thought-heading">{heading[1]}</p>;
        return <p key={index}>{inline(paragraph)}</p>;
      })}
    </>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function currentLabel(steps: RunStep[]): string {
  const last = steps.at(-1);
  if (!last) return "Thinking";
  if (last.kind === "thought") return "Thinking";
  const line = actionLine(last.action);
  return [line.verb, line.target].filter(Boolean).join(" ");
}

function doneLabel(steps: RunStep[]): string {
  const thoughts = steps.filter((step): step is Extract<RunStep, { kind: "thought" }> => step.kind === "thought");
  const actions = steps.length - thoughts.length;
  const seconds = thoughts.reduce((sum, step) => sum + step.thought.seconds, 0);
  const parts: string[] = [];
  if (thoughts.length) parts.push(seconds > 0 ? `Thought for ${formatDuration(seconds)}` : "Thought");
  if (actions) parts.push(`${actions} tool call${actions === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function statusTag(status: string, reason?: string): { label: string; tone: string } | null {
  if (status === "failed") return { label: "Failed", tone: "failed" };
  // An Ask or Plan turn refuses its own writes: not a failure, the mode working as meant.
  if (status === "denied" && reason?.includes("mode only reads")) return { label: "Skipped (read-only mode)", tone: "waiting" };
  if (status === "denied") return { label: "Denied", tone: "failed" };
  if (status === "waiting_approval") return { label: "Waiting for approval", tone: "waiting" };
  if (status === "sleeping") return { label: "Waiting", tone: "waiting" };
  return null;
}

function Chevron(props: { down: boolean; subtle?: boolean }) {
  return (
    <svg
      className={`step-chevron${props.down ? " down" : ""}${props.subtle ? " subtle" : ""}`}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
