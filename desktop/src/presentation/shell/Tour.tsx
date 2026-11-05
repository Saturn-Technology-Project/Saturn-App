import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { Model, Project } from "../../domain/model.js";
import { messageOf } from "../ui/Parts.js";
import type { Screen } from "./navigation.js";
import { TOUR_STEPS } from "./tour-steps.js";

/** Where the boxed element is on screen. */
interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

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
  const [box, setBox] = useState<Box | null>(null);
  const [cardHeight, setCardHeight] = useState(260);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const step = TOUR_STEPS[at];
  const last = at === TOUR_STEPS.length - 1;

  // Each step shows its screen, then the box follows the element once the screen has drawn.
  useEffect(() => {
    if (step.screen) go(step.screen);
  }, [go, step.screen]);

  const measure = useCallback(() => {
    const element = step.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
    if (!element) {
      setBox(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    setBox({ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 });
  }, [step.target]);

  useLayoutEffect(() => {
    measure();
    // A screen that has just been switched to draws a moment later, and its panels a moment after that.
    const soon = window.setTimeout(measure, 120);
    const later = window.setTimeout(measure, 500);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(soon);
      window.clearTimeout(later);
      window.removeEventListener("resize", measure);
    };
  }, [measure, at]);

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

  const place = placeCard(box, cardHeight);
  return (
    <div className="lab-tour" role="dialog" aria-modal="true" aria-labelledby="lab-tour-title">
      {box ? <div className="lab-tour-box" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} /> : <div className="lab-tour-dim" />}
      <div
        className="lab-tour-card"
        style={{ top: place.top, left: place.left, width: CARD_WIDTH }}
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
