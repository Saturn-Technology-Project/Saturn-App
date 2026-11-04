import type { RuntimeStatus } from "../../infrastructure/runtime-status.js";

/** What covers the screens while the runtime is not answering: where it stands, its last output, and a way to try again. */
export function RuntimeGate(props: { status: RuntimeStatus; restart: (() => Promise<void>) | null }) {
  const { status, restart } = props;
  if (status.state === "ready") return null;
  const title = status.state === "blocked" ? "Another Saturn is in the way" : status.state === "failed" ? "Saturn's runtime stopped" : status.attempt > 1 ? "Starting Saturn's runtime again" : "Starting Saturn's runtime";
  const detail = status.state === "blocked" || status.state === "failed" ? status.reason : status.attempt > 1 ? `Attempt ${status.attempt}. Your records are safe in the project folder.` : "This takes a moment.";
  const log = status.state === "starting" || status.state === "failed" ? status.log : [];
  return (
    <div className="lab-gate" role="status" aria-live="polite">
      <div className="lab-gate-card">
        <h2>{title}</h2>
        <p className="lab-lead">{detail}</p>
        {log.length ? (
          <details open={status.state === "failed"}>
            <summary>Its last output</summary>
            <pre className="lab-text">{log.join("\n")}</pre>
          </details>
        ) : null}
        {restart && status.state !== "starting" ? (
          <button type="button" className="lab-button primary" onClick={() => void restart()}>
            Try again
          </button>
        ) : null}
        {!restart && status.state === "starting" ? <p className="lab-muted">Start the runtime with `npm run dev`, or open Saturn's app.</p> : null}
      </div>
    </div>
  );
}
