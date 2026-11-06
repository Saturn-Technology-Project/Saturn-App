import { t } from "../../domain/i18n.js";
import type { RuntimeStatus } from "../../infrastructure/runtime-status.js";
import { Button } from "../ui/base/Button.js";
import { classes } from "../ui/base/classes.js";

/** What covers the screens while the runtime is not answering: where it stands, its last output, and a way to try again. */
export function RuntimeGate(props: { status: RuntimeStatus; restart: (() => Promise<void>) | null }) {
  const { status, restart } = props;
  if (status.state === "ready") return null;
  const title = status.state === "blocked" ? t("Another Saturn is in the way") : status.state === "failed" ? t("Saturn's runtime stopped") : status.attempt > 1 ? t("Starting Saturn's runtime again") : t("Starting Saturn's runtime");
  const detail = status.state === "blocked" || status.state === "failed" ? status.reason : status.attempt > 1 ? t("Attempt {attempt}. Your records are safe in the project folder.", { attempt: status.attempt }) : t("This takes a moment.");
  const log = status.state === "starting" || status.state === "failed" ? status.log : [];
  const tone = status.state === "failed" ? "bg-destructive" : status.state === "blocked" ? "bg-wait" : "bg-info";
  return (
    <div className="absolute inset-x-0 top-(--bar-height) bottom-0 z-50 flex items-center justify-center bg-background p-6" role="status" aria-live="polite">
      <div className="flex w-[min(560px,100%)] flex-col gap-2.5">
        <h2 className="mt-0! flex items-center gap-2 text-(length:--text-title) font-semibold">
          <span aria-hidden="true" className={classes("size-2.5 shrink-0 rounded-full", tone, status.state === "starting" && "animate-pulse")} />
          {title}
        </h2>
        <p className={classes("max-w-[680px]", status.state === "starting" ? "text-muted-foreground" : "text-foreground")}>{detail}</p>
        {log.length ? (
          <details open={status.state === "failed"}>
            <summary className="cursor-pointer text-xs text-muted-foreground">{t("Its last output")}</summary>
            <pre className="mt-2! max-h-60 overflow-auto rounded-md bg-panel px-2.5 py-2 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{log.join("\n")}</pre>
          </details>
        ) : null}
        {restart && status.state !== "starting" ? (
          <Button className="self-start" onClick={() => void restart()}>
            {t("Try again")}
          </Button>
        ) : null}
        {!restart && status.state === "starting" ? <p className="text-xs text-muted-foreground">{t("Start the runtime with {command}, or open Saturn's app.", { command: "npm run dev" })}</p> : null}
      </div>
    </div>
  );
}
