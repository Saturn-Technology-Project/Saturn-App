import { useEffect, useState } from "react";
import type { PlanStep } from "../domain/conversation";

/**
 * The agent's plan as something to work on, not only read: tick steps, reword them, add a note, and send the
 * result back as the next message (the agent then follows the edited plan, or gets its go-ahead). Used for the
 * latest plan of a chat; earlier plans stay read-only.
 */
export function InteractivePlan(props: { runId: string; steps: PlanStep[]; busy: boolean; awaitingGo: boolean; onSend: (text: string) => void }) {
  const [draft, setDraft] = useState(() => props.steps.map((step) => ({ ...step })));
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const done = draft.filter((step) => step.status === "completed").length;

  // A new plan from the agent replaces the draft.
  useEffect(() => {
    setDraft(props.steps.map((step) => ({ ...step })));
    setEditing(false);
  }, [props.runId, props.steps.map((step) => `${step.status}:${step.step}`).join("|")]);

  const changed = draft.some((step, index) => step.step !== props.steps[index]?.step || step.status !== props.steps[index]?.status) || draft.length !== props.steps.length;

  function compose(): string {
    const lines = draft.map((step, index) => `${index + 1}. [${step.status === "completed" ? "x" : " "}] ${step.step}`);
    const header = changed ? "Follow this revised plan:" : props.awaitingGo ? "go" : "About the plan:";
    if (!changed && props.awaitingGo && !note.trim()) return "go";
    return [header, ...lines, note.trim() ? `\nNotes: ${note.trim()}` : ""].filter(Boolean).join("\n");
  }

  return (
    <div className="plan-card interactive">
      <div className="plan-card-head">
        <span>Plan</span>
        <small>{done}/{draft.length} completed</small>
        <button type="button" className="plan-edit" onClick={() => setEditing((value) => !value)} title={editing ? "Done editing" : "Edit the steps"}>
          {editing ? "Done" : "Edit"}
        </button>
      </div>
      <div className="plan-steps">
        {draft.map((step, index) => (
          <div className={`plan-step ${step.status}`} key={index}>
            <input
              type="checkbox"
              checked={step.status === "completed"}
              aria-label={`Step ${index + 1} done`}
              onChange={(event) => setDraft((current) => current.map((item, at) => (at === index ? { ...item, status: event.target.checked ? "completed" : "pending" } : item)))}
            />
            {editing ? (
              <input className="plan-step-input" aria-label={`Step ${index + 1}`} value={step.step} onChange={(event) => setDraft((current) => current.map((item, at) => (at === index ? { ...item, step: event.target.value } : item)))} />
            ) : (
              <span>{step.step}</span>
            )}
            {editing ? (
              <button type="button" className="plan-remove" title="Remove step" aria-label="Remove step" onClick={() => setDraft((current) => current.filter((_, at) => at !== index))}>✕</button>
            ) : null}
          </div>
        ))}
        {editing ? (
          <button type="button" className="plan-add" onClick={() => setDraft((current) => [...current, { step: "", status: "pending" }])}>+ Add a step</button>
        ) : null}
      </div>
      <div className="plan-feedback">
        <input className="input tiny" placeholder={props.awaitingGo ? "Anything to change before it starts? (empty = go ahead)" : "A note for the agent about this plan…"} value={note} onChange={(event) => setNote(event.target.value)} />
        <button type="button" className="btn tiny" disabled={props.busy || (editing && draft.some((step) => !step.step.trim()))} onClick={() => { props.onSend(compose()); setNote(""); setEditing(false); }}>
          {changed ? "Send revised plan" : props.awaitingGo && !note.trim() ? "Go ahead" : "Send"}
        </button>
      </div>
    </div>
  );
}
