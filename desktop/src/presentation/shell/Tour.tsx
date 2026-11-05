import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { Model, Project } from "../../domain/model.js";
import { Button } from "../ui/base/Button.js";
import { Field } from "../ui/base/Field.js";
import { Notice } from "../ui/base/Notice.js";
import { Textarea } from "../ui/base/Textarea.js";
import { messageOf } from "../ui/Parts.js";
import type { Screen } from "./navigation.js";
import { TOUR_STEPS } from "../../domain/workbench.js";
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
  if (top + cardHeight > room.height - 16) top = room.height - cardHeight - 16;
  // A box as tall as the window, like the rail's, starts above it: the card stays clear of the window's edge.
  return { top: Math.max(16, top), left };
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
  /** Something its last step opened is over it: Escape belongs to that. */
  covered: boolean;
}) {
  const { project, go, covered } = props;
  const coveredNow = useRef(covered);
  coveredNow.current = covered;
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
      if (event.key === "Escape" && !coveredNow.current) {
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
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-labelledby="lab-tour-title">
      {box ? <div key={step.id} className="absolute rounded-lg border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} /> : <div className="absolute inset-0 bg-black/45" />}
      <div
        className="glass absolute flex max-w-[calc(100vw-32px)] flex-col gap-2 rounded-xl px-[18px] py-4 text-foreground shadow-lg ring-1 ring-foreground/10"
        style={{ top: place.top, left: place.left, width: CARD_WIDTH, visibility: measuring ? "hidden" : undefined }}
        ref={(element) => {
          if (element && element.offsetHeight !== cardHeight) setCardHeight(element.offsetHeight);
        }}
      >
        <div className="text-[11px] text-muted-foreground">
          {at + 1} of {TOUR_STEPS.length}
        </div>
        <h2 id="lab-tour-title" className="m-0! text-[15px] font-semibold">{step.title}</h2>
        <p className="text-xs leading-normal text-muted-foreground">{step.text}</p>
        {last ? (
          <div className="mt-1 flex flex-col gap-1">
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <div className="flex flex-wrap items-center gap-2 py-1 *:first:min-w-0 *:first:flex-[1_1_220px] *:first:[overflow-wrap:anywhere]">
              <span>{project ? <code>{project.path}</code> : <span className="text-xs text-muted-foreground">No project folder yet</span>}</span>
              <Button variant="outline" onClick={() => void props.onAddProject().catch((reason: unknown) => setError(messageOf(reason)))}>
                {project ? "Another folder" : "Choose a folder"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 py-1 *:first:min-w-0 *:first:flex-[1_1_220px] *:first:[overflow-wrap:anywhere]">
              <span>{props.models.length ? `${props.models.length === 1 ? "1 model" : `${props.models.length} models`} connected for the assistant` : <span className="text-xs text-muted-foreground">No model yet; code and experiments work without one</span>}</span>
              <Button variant="outline" onClick={props.onOpenSettings}>
                {props.models.length ? "Settings" : "Connect a model"}
              </Button>
            </div>
            <Field label="Your first question">
              <Textarea rows={3} value={question} disabled={!project} placeholder="When does this behavior appear during training?" onChange={(event) => setQuestion(event.target.value)} />
            </Field>
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <Button variant="ghost" onClick={() => void props.onFinish()}>
            Skip
          </Button>
          <div className="flex-1" />
          {at > 0 ? (
            <Button variant="outline" onClick={() => setAt(at - 1)}>
              Back
            </Button>
          ) : null}
          {last ? (
            <Button disabled={busy} onClick={() => void start()}>
              {project ? (question.trim() ? "Save the question and start" : "Start") : "Finish"}
            </Button>
          ) : (
            <Button autoFocus onClick={() => setAt(at + 1)}>
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
