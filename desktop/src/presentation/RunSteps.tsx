import { useState, type ReactNode } from "react";
import {
  actionLine,
  isWaitingStep,
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
import { Badge } from "./ui/base/Badge";
import { Button } from "./ui/base/Button";
import { classes } from "./ui/base/classes";
import { Dialog, DialogContent, DialogTitle } from "./ui/base/Dialog";
import { Choice } from "./ui/base/Field";
import { Input } from "./ui/base/Input";
import { Notice } from "./ui/base/Notice";
import { SCOPE_CHOICES } from "./settings/Permissions";
import { suggestedPattern } from "../domain/permissions";
import type { PermissionScope } from "../domain/model";

/** How a step's row looks: quiet, until it is pointed at. */
const STEP_ROW = "h-auto max-w-full w-fit justify-start gap-[7px] px-1 py-0.5 text-left text-[12.5px] font-normal text-muted-foreground hover:text-foreground";

/** The box a run's steps sit in. */
const STEPS_BOX = "my-1 mb-2 flex flex-col gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1";

/**
 * A run's work as a quiet Antigravity-style list: "Thought for 13s ›" rows between one-line tool
 * calls ("Analyzed TS mcp.ts#L1-73"), under a collapsible header, with "Working" while it runs.
 */
export function RunSteps(props: { run: Run; busy: boolean; nested?: boolean }) {
  const { run, busy } = props;
  // What waits for an answer is shown apart, so that it is never folded away; see WaitingSteps.
  const steps = runSteps(run).filter((step) => props.nested || !isWaitingStep(step));
  const [override, setOverride] = useState<boolean | null>(null);
  const childWaiting = Boolean(run.children?.some((child) => child.status === "waiting_approval"));
  if (!steps.length && !busy) return null;
  if (!steps.length) {
    return (
      <div className={STEPS_BOX}>
        <WorkingRow />
      </div>
    );
  }
  const open = override ?? (busy || !run.output || childWaiting);

  return (
    <div className={classes(STEPS_BOX, props.nested && "mt-0.5 mb-0")}>
      <Button variant="ghost" size="small" className="h-auto w-fit gap-1.5 px-1 py-[3px] text-[13px] font-medium text-muted-foreground select-none hover:text-foreground" onClick={() => setOverride(!open)} aria-expanded={open}>
        <span>{busy ? currentLabel(steps) : doneLabel(steps)}</span>
        <Chevron down={open} />
      </Button>
      {open ? (
        <div className="flex flex-col gap-[3px] pl-0.5">
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

/** The steps waiting for the person's answer, open, at the end of the turn where they will be seen. */
export function WaitingSteps(props: { run: Run }) {
  const waiting = runSteps(props.run).filter(isWaitingStep);
  if (!waiting.length) return null;
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="Waiting for your decision">
      {waiting.map((step) => (step.kind === "thought" ? null : <ActionRow key={step.key} runId={props.run.id} action={step.action} />))}
    </div>
  );
}

/** The sub-agent runs a delegate step started: each one's task, state and its own steps, nested under the step. */
function SubAgentRuns(props: { runs: Run[] }) {
  return (
    <div className="my-1 mb-1.5 ml-[22px] flex flex-col gap-1.5">
      {props.runs.map((child) => {
        const busy = child.status === "running" || child.status === "queued" || child.status === "waiting_approval" || child.status === "sleeping";
        const state = child.status === "waiting_approval" ? "needs your approval" : child.status === "completed" ? "done" : child.status === "failed" ? "failed" : child.status === "cancelled" ? "stopped" : "working";
        return (
          <div className={classes("rounded-lg border border-l-2 border-border border-l-input bg-card px-2.5 py-1.5", child.status === "waiting_approval" && "border-l-wait", child.status === "failed" && "border-l-destructive")} key={child.id}>
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <Badge className="text-[10.5px] tracking-wide uppercase">{child.delegated?.tools === "all" ? "sub-agent" : "sub-agent · read-only"}</Badge>
              <span className="min-w-0 flex-1 truncate text-foreground" title={child.delegated?.task ?? child.input}>{child.delegated?.task ?? child.input}</span>
              <span className={classes("text-[11.5px] whitespace-nowrap text-muted-foreground", child.status === "waiting_approval" && "text-wait", child.status === "failed" && "text-destructive", child.status === "completed" && "text-good")}>{state}</span>
            </div>
            <RunSteps run={child} busy={busy} nested />
            {child.output ? <div className="mt-1.5 max-h-40 overflow-auto text-[12.5px] whitespace-pre-wrap text-muted-foreground">{child.output}</div> : null}
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
    <div className="flex flex-col gap-1">
      <Button variant="ghost" size="small" className={classes(STEP_ROW, "font-medium")} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="shrink-0 text-(--subtle) group-hover/button:text-muted-foreground">{thought.seconds > 0 ? `Thought for ${formatDuration(thought.seconds)}` : "Thought"}</span>
        <Chevron down={open} />
      </Button>
      {open ? (
        <div className="my-1 mb-2 max-h-[380px] overflow-y-auto rounded-[10px] border border-border bg-(--code-bg) px-4 py-3 font-mono text-xs leading-[1.6] text-muted-foreground">
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

/** The arguments or result of a step, as text that wraps and scrolls. */
const DETAIL_TEXT = "max-h-[220px] overflow-auto font-mono text-[11.5px] leading-normal break-words whitespace-pre-wrap text-foreground";

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
    <div className="group/step flex flex-col gap-1">
      <Button
        variant="ghost"
        size="small"
        className={STEP_ROW}
        onClick={() => hasDetails && setOpen((value) => !value)}
        aria-expanded={hasDetails ? open : undefined}
        title={action.toolId}
      >
        <span className="shrink-0 text-(--subtle) group-hover/button:text-muted-foreground">{line.verb}</span>
        <ActionTarget line={line} />
        {state ? <Badge tone={state.tone === "failed" ? "bad" : "wait"} className="h-auto rounded px-[5px] py-px text-[10px] font-semibold">{state.label}</Badge> : null}
        {hasDetails ? <Chevron down={open} subtle /> : null}
      </Button>
      {props.restorable ? (
        confirmRestore ? (
          <span className="my-1 mb-1.5 ml-7 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Put the files back to just before this step? Later steps and turns are undone too.</span>
            <Button variant="danger" size="small" disabled={restoring} onClick={() => void restoreHere()}>Restore</Button>
            <Button variant="outline" size="small" disabled={restoring} onClick={() => setConfirmRestore(false)}>Cancel</Button>
          </span>
        ) : (
          <Button variant="outline" size="small" className="my-0.5 mb-1 ml-7 h-5 w-fit px-2 text-[11px] font-normal text-muted-foreground opacity-0 transition-opacity group-hover/step:opacity-100 focus-visible:opacity-100" title="Put the files back to how they were just before this step" onClick={() => setConfirmRestore(true)}>
            Restore to here
          </Button>
        )
      ) : null}

      {waiting ? (
        <Notice tone="wait" role="group" aria-label={`Approve ${action.toolId}?`} className="my-1 mb-1.5 ml-[22px] flex flex-wrap items-center gap-2 border-wait px-2.5 py-2 whitespace-normal">
          <span className="flex-1 text-[12.5px] text-foreground">Allow {action.toolId} to run?</span>
          {decisionError ? <span className="basis-full text-xs text-destructive">{decisionError}</span> : null}
          <Button variant="ghost" size="small" disabled={deciding} onClick={() => void decide(false)}>
            Deny
          </Button>
          <Button size="small" disabled={deciding} onClick={() => void decide(true)}>
            Approve
          </Button>
          {always ? (
            <form className="flex basis-full flex-wrap items-center gap-1.5 border-t border-border pt-1.5" onSubmit={(event) => { event.preventDefault(); void allowAlways(); }}>
              <span className="text-xs text-muted-foreground">Allow <code className="font-mono">{action.toolId}</code> matching</span>
              <Input className="h-7 w-[180px] font-mono text-xs" aria-label="Rule pattern" value={pattern} onChange={(event) => setPattern(event.target.value)} />
              <span className="text-xs text-muted-foreground">in</span>
              <Choice ariaLabel="Where the rule applies" className="w-36" triggerClassName="h-7 text-xs" value={scope} options={SCOPE_CHOICES.map((item) => ({ value: item.id, label: item.label }))} onChange={(next) => setScope(next as PermissionScope)} />
              <Button variant="outline" size="small" type="submit" disabled={deciding || !pattern.trim()}>Save and approve</Button>
              <Button variant="ghost" size="small" disabled={deciding} onClick={() => setAlways(false)}>Cancel</Button>
            </form>
          ) : (
            <Button variant="ghost" size="small" disabled={deciding} onClick={() => setAlways(true)} title="Save a rule so calls like this one run without asking">
              Always allow…
            </Button>
          )}
        </Notice>
      ) : null}

      {props.children}

      {/* Screenshot displayed right below Called computer_screenshot */}
      {recording ? <RecordingPlayer runId={props.runId} name={recording.name} frames={recording.frames} seconds={recording.seconds} /> : null}
      {screenshotImg ? (
        <div className="my-1 mb-1.5 ml-3.5">
          <div
            className="group/shot relative inline-block max-h-[85px] w-[140px] max-w-[140px] cursor-zoom-in overflow-hidden rounded-md border border-input bg-background shadow-sm transition hover:-translate-y-px hover:shadow-md"
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
              className="block h-[85px] w-full bg-black object-cover"
              loading="lazy"
            />
            <span className="pointer-events-none absolute right-1 bottom-1 rounded-[3px] bg-black/75 px-[5px] py-px text-[9.5px] font-medium text-white opacity-85 backdrop-blur-xs group-hover/shot:opacity-100">🔍 Zoom</span>
          </div>
        </div>
      ) : null}

      <Dialog open={modalOpen && Boolean(screenshotImg)} onOpenChange={(next) => { if (!next) setModalOpen(false); }}>
        <DialogContent className="w-auto max-w-[90vw] gap-0 overflow-hidden bg-black! p-0 sm:max-w-[90vw]">
          <DialogTitle className="sr-only">Screenshot</DialogTitle>
          {screenshotImg ? <img className="block max-h-[90vh] max-w-[90vw] object-contain" src={screenshotImg} alt="Screenshot full view" /> : null}
          <Button variant="ghost" className="absolute top-2.5 right-2.5 size-8 rounded-full border-white/30 bg-black/60 p-0 text-base text-white hover:bg-black/80 hover:text-white" aria-label="Close screenshot" onClick={() => setModalOpen(false)}>
            ✕
          </Button>
        </DialogContent>
      </Dialog>

      {open && hasDetails ? (
        <div className="my-1 mb-2 flex flex-col gap-2 rounded-lg border border-border bg-(--code-bg) px-3.5 py-2.5">
          {argsText ? (
            <div className="flex flex-col gap-1">
              <div className="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">Arguments</div>
              <pre className={DETAIL_TEXT}>{argsText}</pre>
            </div>
          ) : null}
          {resultText ? (
            <div className="flex flex-col gap-1">
              <div className="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{action.reason ? "Reason" : "Result"}</div>
              <pre className={DETAIL_TEXT}>{resultText}</pre>
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
    <span className="inline-flex min-w-0 items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap">
      {line.badge ? <Badge tone="info" className="h-auto shrink-0 rounded-[3px] px-1 py-px font-mono text-[9.5px] leading-[1.1] font-bold">{line.badge}</Badge> : null}
      <span className={classes("truncate text-muted-foreground group-hover/button:text-foreground", line.mono && "font-mono text-[11.5px]")}>{line.target}</span>
      {line.suffix ? <span className="shrink-0 font-mono text-[11.5px] text-(--subtle)">{line.suffix}</span> : null}
    </span>
  );
}

function WorkingRow() {
  return <div className="inline-flex animate-pulse items-center gap-1.5 px-1 py-[3px] text-[12.5px] font-medium text-muted-foreground">Working</div>;
}

/** Plain reasoning text: blank-line paragraphs, "**Heading**" lines, inline **bold** and `code`. */
function ThoughtText(props: { text: string }) {
  const paragraphs = props.text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const heading = paragraph.match(/^\*\*(.+?)\*\*$/);
        if (heading) return <p key={index} className="mt-2.5 mb-1 font-sans text-[12.5px] font-semibold text-foreground first:mt-0">{heading[1]}</p>;
        return <p key={index} className="mb-2.5 last:mb-0">{inline(paragraph)}</p>;
      })}
    </>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index} className="rounded bg-foreground/10 px-[5px] py-px text-[11px]">{part.slice(1, -1)}</code>;
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
      className={classes("shrink-0 text-(--subtle) transition-transform", props.down && "rotate-90", props.subtle && "opacity-50")}
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
