import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import type { FileChange, Run, RunChanges } from "../domain/model";
import { activateOnKey } from "./keyboard";

/** Sent after any revert or restore, so every card (chat and Changes tab) reloads its files. */
const CHANGED_EVENT = "saturn:run-changes";

/** True when the run left a reviewable change in its project folder. */
export function hasFileChanges(run: Run): boolean {
  return Boolean(run.checkpoint?.files.some((file) => file.before !== file.after));
}

function busy(run: Run): boolean {
  return run.status === "running" || run.status === "queued" || run.status === "waiting_approval";
}

/**
 * Cursor-style review under a finished run: "N files changed" with +/- counts, a diff per file, and
 * Revert file / Revert all / Keep, plus "Restore to before this turn" for the whole chat from here on.
 */
export function RunChangesCard(props: { run: Run; defaultOpen?: boolean; onComment?: (text: string) => void }) {
  const { run } = props;
  /** Comments on diff lines, keyed "path:lineIndex", until they are sent to the agent as one message. */
  const [comments, setComments] = useState<Record<string, string>>({});
  const commentCount = Object.values(comments).filter((text) => text.trim()).length;

  function sendComments() {
    if (!changes || !props.onComment) return;
    const lines: string[] = [];
    for (const [key, text] of Object.entries(comments)) {
      if (!text.trim()) continue;
      const at = key.lastIndexOf(":");
      const file = key.slice(0, at);
      const index = Number(key.slice(at + 1));
      const diffLine = changes.files.find((item) => item.path === file)?.diff.split("\n")[index] ?? "";
      lines.push(`- \`${file}\` at \`${diffLine.trim().slice(0, 120)}\`: ${text.trim()}`);
    }
    props.onComment(`About your changes:\n${lines.join("\n")}\n\nPlease address these.`);
    setComments({});
  }
  const [changes, setChanges] = useState<RunChanges | null>(null);
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [error, setError] = useState("");
  const signature = JSON.stringify(run.checkpoint?.files ?? []);
  const show = hasFileChanges(run) && !busy(run);

  useEffect(() => {
    if (!show) return;
    let live = true;
    const load = () =>
      desktop.runs
        .changes(run.id)
        .then((next) => live && setChanges(next))
        .catch((reason: unknown) => live && setError(reason instanceof Error ? reason.message : "Could not load the changes"));
    void load();
    window.addEventListener(CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(CHANGED_EVENT, load);
    };
  }, [run.id, show, signature]);

  if (!show || !changes || !changes.files.length) return null;
  const files = changes.files;
  const pending = files.filter((file) => file.review === "pending");
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const allReverted = files.every((file) => file.review === "reverted");

  async function act(work: () => Promise<unknown>) {
    setWorking(true);
    setError("");
    try {
      const result = await work();
      if (result && typeof result === "object" && "files" in result && "runId" in result) setChanges(result as RunChanges);
      window.dispatchEvent(new Event(CHANGED_EVENT));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That did not work");
    } finally {
      setWorking(false);
      setConfirmRestore(false);
    }
  }

  return (
    <div className={`changes-card${allReverted ? " reverted" : ""}`}>
      <div className="changes-card-head">
        <button type="button" className="changes-card-title" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Chevron down={open} />
          <span>
            {files.length} {files.length === 1 ? "file" : "files"} changed
          </span>
          <Counts additions={additions} deletions={deletions} />
          {allReverted ? <span className="changes-tag">Reverted</span> : !pending.length ? <span className="changes-tag">Kept</span> : null}
        </button>
        {pending.length ? (
          <div className="changes-card-actions">
            <button type="button" className="changes-btn" disabled={working} onClick={() => void act(() => desktop.runs.revertChanges(run.id))}>
              Revert all
            </button>
            <button type="button" className="changes-btn primary" disabled={working} onClick={() => void act(() => desktop.runs.keepChanges(run.id))}>
              Keep
            </button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="changes-files">
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              open={expanded === file.path}
              working={working}
              onToggle={() => setExpanded(expanded === file.path ? null : file.path)}
              onRevert={() => void act(() => desktop.runs.revertChanges(run.id, file.path))}
              comments={props.onComment ? Object.fromEntries(Object.entries(comments).filter(([key]) => key.startsWith(`${file.path}:`)).map(([key, text]) => [key.slice(file.path.length + 1), text])) : undefined}
              onCommentChange={props.onComment ? (lineIndex, text) => setComments((current) => ({ ...current, [`${file.path}:${lineIndex}`]: text })) : undefined}
            />
          ))}
          <div className="changes-card-foot">
            {confirmRestore ? (
              <>
                <span>Put every file this chat changed back to how it was before this turn? Later turns are reverted too; messages stay.</span>
                <button type="button" className="changes-btn danger" disabled={working} onClick={() => void act(() => desktop.runs.restoreTo(run.id))}>
                  Restore
                </button>
                <button type="button" className="changes-btn" disabled={working} onClick={() => setConfirmRestore(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="changes-link" disabled={working} onClick={() => setConfirmRestore(true)}>
                Restore to before this turn
              </button>
            )}
          </div>
        </div>
      ) : null}
      {error ? <div className="changes-error">{error}</div> : null}
      {commentCount && props.onComment ? (
        <div className="changes-comments-bar">
          <span className="hint">{commentCount} comment{commentCount === 1 ? "" : "s"} on the diff</span>
          <button type="button" className="changes-btn" onClick={sendComments}>Send to agent</button>
        </div>
      ) : null}
    </div>
  );
}

function FileRow(props: { file: FileChange; open: boolean; working: boolean; onToggle: () => void; onRevert: () => void; comments?: Record<string, string>; onCommentChange?: (lineIndex: number, text: string) => void }) {
  const { file } = props;
  const reverted = file.review === "reverted";
  return (
    <div className="changes-file">
      <div className="changes-file-row">
        <button type="button" className="changes-file-name" onClick={props.onToggle} aria-expanded={props.open}>
          <Chevron down={props.open} />
          <span className={`changes-status ${file.status}`}>{file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}</span>
          <span className={`changes-path${reverted ? " reverted" : ""}`} title={file.path}>
            {file.path}
          </span>
          {file.binary ? <span className="changes-tag">binary</span> : <Counts additions={file.additions} deletions={file.deletions} />}
          {file.modifiedSince ? (
            <span className="changes-tag warn" title="The file was changed again after this turn; reverting puts back the version from before this turn.">
              changed since
            </span>
          ) : null}
        </button>
        {reverted ? (
          <span className="changes-tag">Reverted</span>
        ) : (
          <button type="button" className="changes-btn small" disabled={props.working} onClick={props.onRevert}>
            Revert
          </button>
        )}
      </div>
      {props.open ? <DiffBlock diff={file.diff} truncated={file.truncated} comments={props.comments} onCommentChange={props.onCommentChange} /> : null}
    </div>
  );
}

export function DiffBlock(props: { diff: string; truncated?: boolean; comments?: Record<string, string>; onCommentChange?: (lineIndex: number, text: string) => void }) {
  const lines = props.diff.replace(/\n$/, "").split("\n");
  const [commenting, setCommenting] = useState<number | null>(null);
  const commentable = Boolean(props.onCommentChange);
  return (
    <pre className="diff-pre changes-diff">
      {lines.map((line, index) => {
        const comment = props.comments?.[String(index)];
        const open = commenting === index || Boolean(comment);
        const kind =
          line.startsWith("+++") || line.startsWith("---")
            ? "diff-line-meta"
            : line.startsWith("+")
              ? "diff-line-add"
              : line.startsWith("-")
                ? "diff-line-del"
                : line.startsWith("@@") || line.startsWith("\\")
                  ? "diff-line-meta"
                  : "diff-line-ctx";
        return (
          <div key={index}>
            <div
              className={`diff-line ${kind}${commentable ? " commentable" : ""}${comment ? " commented" : ""}`}
              title={commentable && !open ? "Click to comment on this line" : undefined}
              role={commentable ? "button" : undefined}
              tabIndex={commentable ? 0 : undefined}
              aria-expanded={commentable ? open : undefined}
              onKeyDown={commentable ? activateOnKey : undefined}
              onClick={commentable ? () => setCommenting((current) => (current === index ? null : index)) : undefined}
            >
              {line || " "}
            </div>
            {open && commentable ? (
              <div className="diff-comment">
                <input
                  className="input tiny"
                  autoFocus={commenting === index}
                  aria-label="Comment for the agent"
                  placeholder="Comment for the agent…"
                  value={comment ?? ""}
                  onChange={(event) => props.onCommentChange?.(index, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setCommenting(null);
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
      {props.truncated ? <div className="diff-line diff-line-meta">… diff cut short; reverting still restores the whole file</div> : null}
    </pre>
  );
}

function Counts(props: { additions: number; deletions: number }) {
  return (
    <span className="changes-counts">
      {props.additions ? <span className="add">+{props.additions}</span> : null}
      {props.deletions ? <span className="del">−{props.deletions}</span> : null}
    </span>
  );
}

function Chevron(props: { down: boolean }) {
  return (
    <svg className={`changes-chevron${props.down ? " down" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 L6.5 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
