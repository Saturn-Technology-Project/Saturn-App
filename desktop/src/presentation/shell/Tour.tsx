import { useEffect, useLayoutEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { Model, Project } from "../../domain/model.js";
import { messageOf } from "../ui/Parts.js";
import type { Screen } from "./navigation.js";
import { TOUR_STEPS } from "./tour-steps.js";
import { followTourTarget, type TourBox } from "./tour-focus.js";

/** Where the boxed element is on screen. */
type Box = TourBox;

const CARD_WIDTH = 340;
const GAP = 14;

/** Where the card goes: beside the box when there is room, under it otherwise, and never off screen. */
function placeCard(box: Box | null, cardHeight: number): { top: number; left: number } {
  const room = { width: window.innerWidth, height: window.innerHeight };
  if (!box) return { top: Math.max(24, (room.height - cardHeight) / 2), left: Math.max(16, (room.width - CARD_WIDTH) / 2) };
  let left = box.left + box.width + GAP;
  let top = box.top;
  if (left + CARD_WIDTH > room.width - 16) {
    left = Math.max(16, Math.min(box.left, room.width - CARD_WIDTH - 16));
    top = box.top + box.height + GAP;
  }
  if (top + cardHeight > room.height - 16) top = Math.max(16, room.height - cardHeight - 16);
  return { top, left };
}

/**
 * A guided tour over the live interface: a box around each part with a card that says what it is for, screen by
 * screen, ending with the first steps of a piece of research. The interface stays live underneath, so what is
 * described is what is there.
 */
export function Tour(props: {
  project: Project | null;
  models: Model[];
  go: (screen: Screen) => void;
  onAddProject: () => Promise<void>;
  onOpenSettings: () => void;
  onFinish: () => Promise<void>;
}) {
  const { project, go } = props;
  const [at, setAt] = useState(0);
  const [focus, setFocus] = useState<{ stepId: string; box: Box | null } | null>(null);
  const [cardHeight, setCardHeight] = useState(260);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const step = TOUR_STEPS[at];
  const last = at === TOUR_STEPS.length - 1;

  // A new step never reuses the preceding rectangle. Follow actual layout frames, including delayed panels and resize.
  useLayoutEffect(() => {
    if (step.screen) go(step.screen);
    return followTourTarget(() => {
      const element = step.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
      const rect = element?.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0 ? { top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 } : null;
    }, (box) => setFocus({ stepId: step.id, box }), (callback) => window.requestAnimationFrame(callback), (frame) => window.cancelAnimationFrame(frame));
  }, [go, step.id, step.screen, step.target]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void props.onFinish();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Finishing is the same whichever step is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setBusy(true);
    try {
      if (project && question.trim()) await desktop.research.addQuestion(project.id, question.trim());
      await props.onFinish();
      go(project ? "Workspace" : "Home");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  const measuring = focus?.stepId !== step.id;
  const box = measuring ? null : focus.box;
  const place = placeCard(box, cardHeight);
  return (
    <div className="lab-tour" role="dialog" aria-modal="true" aria-labelledby="lab-tour-title">
      {box ? <div key={step.id} className="lab-tour-box" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} /> : <div className="lab-tour-dim" />}
      <div
        className="lab-tour-card"
        style={{ top: place.top, left: place.left, width: CARD_WIDTH, visibility: measuring ? "hidden" : undefined }}
        ref={(element) => {
          if (element && element.offsetHeight !== cardHeight) setCardHeight(element.offsetHeight);
        }}
      >
        <div className="lab-muted lab-tour-count">
          {at + 1} of {TOUR_STEPS.length}
        </div>
        <h2 id="lab-tour-title">{step.title}</h2>
        <p>{step.text}</p>
        {last ? (
          <div className="lab-tour-start">
            {error ? <div className="lab-notice bad" role="alert">{error}</div> : null}
            <div className="lab-row">
              <span>{project ? <code>{project.path}</code> : <span className="lab-muted">No project folder yet</span>}</span>
              <button type="button" className="lab-button" onClick={() => void props.onAddProject().catch((reason: unknown) => setError(messageOf(reason)))}>
                {project ? "Another folder" : "Choose a folder"}
              </button>
            </div>
            <div className="lab-row">
              <span>{props.models.length ? `${props.models.length === 1 ? "1 model" : `${props.models.length} models`} connected for the assistant` : <span className="lab-muted">No model yet; code and experiments work without one</span>}</span>
              <button type="button" className="lab-button" onClick={props.onOpenSettings}>
                {props.models.length ? "Settings" : "Connect a model"}
              </button>
            </div>
            <label className="lab-field">
              Your first question
              <textarea rows={3} value={question} disabled={!project} placeholder="When does this behavior appear during training?" onChange={(event) => setQuestion(event.target.value)} />
            </label>
          </div>
        ) : null}
        <div className="lab-tour-actions">
          <button type="button" className="lab-button quiet" onClick={() => void props.onFinish()}>
            Skip
          </button>
          <div className="lab-rail-space" />
          {at > 0 ? (
            <button type="button" className="lab-button" onClick={() => setAt(at - 1)}>
              Back
            </button>
          ) : null}
          {last ? (
            <button type="button" className="lab-button primary" disabled={busy} onClick={() => void start()}>
              {project ? (question.trim() ? "Save the question and start" : "Start") : "Finish"}
            </button>
          ) : (
            <button type="button" className="lab-button primary" autoFocus onClick={() => setAt(at + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
