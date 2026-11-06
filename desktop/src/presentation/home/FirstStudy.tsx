import { askAssistant } from "../../application/assistant-requests.js";
import { firstStudySteps, nextStep, type StepAction, type StudyProgress } from "../../domain/first-study.js";
import { t } from "../../domain/i18n.js";
import type { Screen } from "../../domain/workbench.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { classes } from "../ui/base/classes.js";

/**
 * The first study as a checklist at the top of Home: each step is done when the records say so, and the next one
 * says why it matters and offers what to do, including handing it to the assistant.
 */
export function FirstStudy(props: { progress: StudyProgress; go: (screen: Screen) => void; onField: (field: "question" | "hypothesis") => void; onHide: () => void }) {
  const steps = firstStudySteps(props.progress);
  const next = nextStep(steps);
  if (!next) return null;
  const done = steps.filter((step) => step.done).length;

  const act = (action: StepAction) => {
    if (action.kind === "screen") props.go(action.screen);
    else if (action.kind === "field") props.onField(action.field);
    else askAssistant(action.prompt);
  };

  return (
    <Card className="mt-3 gap-2 border-0 bg-panel px-4 py-3.5" role="region" aria-label={t("Your first study")}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{t("Your first study")}</h2>
        <span className="text-xs text-muted-foreground">{t("{done} of {count} done", { done, count: steps.length })}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="small" className="text-muted-foreground" onClick={props.onHide}>
          {t("Hide")}
        </Button>
      </div>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {steps.map((step, index) => {
          const current = step.id === next.id;
          return (
            <li key={step.id} className={classes("flex flex-col gap-1 rounded-md px-2 py-1.5", current && "bg-muted")} aria-current={current ? "step" : undefined}>
              <div className="flex items-center gap-2 text-sm">
                <span aria-hidden="true" className={classes("grid size-5 flex-none place-items-center rounded-full border text-[11px]", step.done ? "border-transparent bg-primary text-primary-foreground" : "border-border text-muted-foreground")}>
                  {step.done ? "✓" : index + 1}
                </span>
                <span className={classes(step.done && "text-muted-foreground line-through decoration-muted-foreground/60")}>{step.title}</span>
                <span className="sr-only">{step.done ? t("Done") : t("Not done yet")}</span>
              </div>
              {current ? (
                <div className="ml-7 flex flex-col gap-2">
                  <p className="m-0 text-xs text-muted-foreground">{step.why}</p>
                  <div className="flex flex-wrap gap-2">
                    {step.actions.map((item, position) => (
                      <Button key={item.label} size="small" variant={position === 0 ? "default" : "outline"} onClick={() => act(item.action)}>
                        {item.label}
                      </Button>
                    ))}
                  </div>
                  {step.id === "results" ? <p className="m-0 text-[11px] text-muted-foreground">{t("The request opens in the assistant's box for you to read and send. It previews each file and imports only after you agree.")}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
