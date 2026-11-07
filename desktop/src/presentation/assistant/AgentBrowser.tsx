import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { AgentBrowserFrame, AgentBrowserState } from "../../domain/model.js";
import { t } from "../../domain/i18n.js";
import { classes } from "../ui/base/classes.js";

/** The agent's browser as the runtime streams it: whether it is open and where, and its page's newest frame. Watched for as
 * long as the panel is shown, reconnecting when the runtime restarts. */
export function useAgentBrowser(): { state: AgentBrowserState | null; frame: AgentBrowserFrame | null } {
  const [state, setState] = useState<AgentBrowserState | null>(null);
  const [frame, setFrame] = useState<AgentBrowserFrame | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await desktop.live.watchBrowser(
            (next) => {
              setState(next);
              if (!next.open) setFrame(null);
            },
            setFrame,
            controller.signal,
          );
        } catch {
          // The runtime is restarting, or this view is closing: tried again below unless it closed.
        }
        if (controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    })();
    return () => controller.abort();
  }, []);
  return { state, frame };
}

/** The agent's browser, live and read-only: its address and its page with the agent's cursor. A window of Chrome or Safari
 * that the agent drives is said to be where it is, with its page here when the runtime sends one. */
export function AgentBrowserView(props: { state: AgentBrowserState | null; frame: AgentBrowserFrame | null; onBack: () => void }) {
  const { state, frame } = props;
  const url = frame?.url ?? state?.url ?? "";
  // The page fits the panel, or shows at its own size to be read, scrolling in the panel.
  const [actual, setActual] = useState(false);
  if (!state?.open) {
    return (
      <div className="m-auto flex max-w-[240px] flex-col items-center gap-2 p-4 text-center text-xs text-muted-foreground">
        <p className="m-0">{t("The assistant's browser is closed. When the assistant opens a page, it shows here live.")}</p>
        <button type="button" className="cursor-pointer border-0 bg-transparent text-info hover:underline" onClick={props.onBack}>
          {t("Back to the chat")}
        </button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="flex flex-none items-center gap-1.5 text-[11px] font-medium text-good">
          <span className="size-1.5 animate-pulse rounded-full bg-good" aria-hidden="true" />
          {t("Live")}
        </span>
        <input
          readOnly
          className="h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[11px] text-muted-foreground outline-none"
          aria-label={t("Address of the assistant's page")}
          value={url === "about:blank" ? "" : url}
          placeholder={t("Opening…")}
          title={url}
        />
        {frame ? (
          <button type="button" className="flex-none cursor-pointer rounded border-0 bg-transparent px-1 text-[11px] text-muted-foreground hover:text-foreground" aria-pressed={actual} onClick={() => setActual((current) => !current)}>
            {actual ? t("Fit") : t("Actual size")}
          </button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-background p-2">
        {frame ? (
          <img
            className={classes("h-auto rounded-md border border-border shadow-sm select-none", actual ? "max-w-none cursor-zoom-out" : "max-w-full cursor-zoom-in")}
            style={actual ? { width: frame.width } : undefined}
            onClick={() => setActual((current) => !current)}
            src={`data:image/${frame.format ?? "jpeg"};base64,${frame.data}`}
            alt={frame.title || t("The assistant's page")}
            draggable={false}
          />
        ) : (
          <p className="m-auto text-xs text-muted-foreground">
            {state.mode === "system" ? t("The assistant is browsing in a Chrome window.") : state.mode === "safari" ? t("The assistant is browsing in a Safari window.") : t("Waiting for the page…")}
          </p>
        )}
      </div>
      <p className="m-0 flex-none border-t border-border px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">
        {t("You watch here; the assistant alone drives this browser. It has its own profile, without your logins.")}
      </p>
    </div>
  );
}
