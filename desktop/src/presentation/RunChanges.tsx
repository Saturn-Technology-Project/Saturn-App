import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import { t } from "../domain/i18n";
import type { FileChange, Run, RunChanges } from "../domain/model";
import { activateOnKey } from "./keyboard";
import { Badge } from "./ui/base/Badge.js";
import { Button } from "./ui/base/Button.js";
import { classes } from "./ui/base/classes.js";
import { Input } from "./ui/base/Input.js";
import { Notice } from "./ui/base/Notice.js";

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
        .catch((reason: unknown) => live && setError(reason instanceof Error ? reason.message : t("Could not load the changes")));
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
      setError(reason instanceof Error ? reason.message : t("That did not work"));
    } finally {
      setWorking(false);
      setConfirmRestore(false);
    }
  }

  return (
    <div className={classes("my-1.5 mb-2.5 overflow-hidden rounded-lg border border-border bg-card text-xs", allReverted && "opacity-75")}>
      <div className="flex items-center gap-2 bg-panel py-1.5 pr-2 pl-1">
        <Button variant="ghost" size="small" className="h-auto min-w-0 flex-1 justify-start gap-1.5 px-1 py-0.5 text-xs font-semibold" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Chevron down={open} />
          <span>{files.length === 1 ? t("1 file changed") : t("{count} files changed", { count: files.length })}</span>
          <Counts additions={additions} deletions={deletions} />
          {allReverted ? <Tag>{t("Reverted")}</Tag> : !pending.length ? <Tag>{t("Kept")}</Tag> : null}
        </Button>
        {pending.length ? (
          <div className="flex shrink-0 gap-1.5">
            <Button variant="outline" size="small" disabled={working} onClick={() => void act(() => desktop.runs.revertChanges(run.id))}>
              {t("Revert all")}
            </Button>
            <Button size="small" disabled={working} onClick={() => void act(() => desktop.runs.keepChanges(run.id))}>
              {t("Keep")}
            </Button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="divide-y divide-border border-t border-border">
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
          <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            {confirmRestore ? (
              <>
                <span className="min-w-[180px] flex-1">{t("Put every file this chat changed back to how it was before this turn? Later turns are reverted too; messages stay.")}</span>
                <Button variant="danger" size="small" disabled={working} onClick={() => void act(() => desktop.runs.restoreTo(run.id))}>
                  {t("Restore")}
                </Button>
                <Button variant="outline" size="small" disabled={working} onClick={() => setConfirmRestore(false)}>
                  {t("Cancel")}
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="small" className="h-5 px-1.5 text-[11px] text-muted-foreground" disabled={working} onClick={() => setConfirmRestore(true)}>
                {t("Restore to before this turn")}
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {error ? <Notice tone="bad" className="rounded-none border-x-0 border-b-0">{error}</Notice> : null}
      {commentCount && props.onComment ? (
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">{commentCount === 1 ? t("1 comment on the diff") : t("{count} comments on the diff", { count: commentCount })}</span>
          <Button variant="outline" size="small" onClick={sendComments}>{t("Send to agent")}</Button>
        </div>
      ) : null}
    </div>
  );
}

/** The letter in front of a file: how it changed, in the color of what that means. */
const STATUS_COLORS: Record<FileChange["status"], string> = { added: "text-good", deleted: "text-destructive", modified: "text-wait" };

/** A small word beside a file or the whole change. */
function Tag(props: { warn?: boolean; title?: string; children: string }) {
  return (
    <Badge tone={props.warn ? "wait" : "neutral"} className="h-4 rounded px-1.5 text-[10.5px]" title={props.title}>
      {props.children}
    </Badge>
  );
}

/** One changed file: its name and counts, a Revert button, and its diff when opened. */
function FileRow(props: { file: FileChange; open: boolean; working: boolean; onToggle: () => void; onRevert: () => void; comments?: Record<string, string>; onCommentChange?: (lineIndex: number, text: string) => void }) {
  const { file } = props;
  const reverted = file.review === "reverted";
  return (
    <div>
      <div className="flex items-center gap-2 py-[3px] pr-2 pl-1">
        <Button variant="ghost" size="small" className="h-auto min-w-0 flex-1 justify-start gap-1.5 px-1 py-0.5 text-xs font-normal" onClick={props.onToggle} aria-expanded={props.open}>
          <Chevron down={props.open} />
          <span className={classes("w-3.5 shrink-0 text-center font-mono text-[10.5px] font-bold", STATUS_COLORS[file.status])}>{file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}</span>
          <span className={classes("min-w-0 truncate font-mono text-[11.5px] group-hover/button:underline", reverted && "text-muted-foreground line-through")} title={file.path}>
            {file.path}
          </span>
          {file.binary ? <Tag>{t("binary")}</Tag> : <Counts additions={file.additions} deletions={file.deletions} />}
          {file.modifiedSince ? (
            <Tag warn title={t("The file was changed again after this turn; reverting puts back the version from before this turn.")}>
              {t("changed since")}
            </Tag>
          ) : null}
        </Button>
        {reverted ? (
          <Tag>{t("Reverted")}</Tag>
        ) : (
          <Button variant="outline" size="small" className="h-5 px-2 text-[11px]" disabled={props.working} onClick={props.onRevert}>
            {t("Revert")}
          </Button>
        )}
      </div>
      {props.open ? <DiffBlock diff={file.diff} truncated={file.truncated} comments={props.comments} onCommentChange={props.onCommentChange} /> : null}
    </div>
  );
}

/** A diff's lines: additions and deletions tinted, and, when `onCommentChange` is given, a comment under any line. */
export function DiffBlock(props: { diff: string; truncated?: boolean; comments?: Record<string, string>; onCommentChange?: (lineIndex: number, text: string) => void }) {
  const lines = props.diff.replace(/\n$/, "").split("\n");
  const [commenting, setCommenting] = useState<number | null>(null);
  const commentable = Boolean(props.onCommentChange);
  return (
    <pre className="m-0 max-h-[420px] overflow-auto border-t border-border bg-background py-1.5 font-mono text-[11px] leading-normal">
      {lines.map((line, index) => {
        const comment = props.comments?.[String(index)];
        const open = commenting === index || Boolean(comment);
        const kind =
          line.startsWith("+++") || line.startsWith("---")
            ? DIFF_META
            : line.startsWith("+")
              ? "bg-good/12 text-good"
              : line.startsWith("-")
                ? "bg-destructive/12 text-destructive"
                : line.startsWith("@@") || line.startsWith("\\")
                  ? DIFF_META
                  : "text-muted-foreground";
        return (
          <div key={index}>
            <div
              className={classes("px-2.5 py-px whitespace-pre", kind, commentable && "cursor-pointer hover:-outline-offset-1 hover:outline hover:outline-dashed hover:outline-input", comment && "shadow-[inset_3px_0_0_var(--wait)]")}
              title={commentable && !open ? t("Click to comment on this line") : undefined}
              role={commentable ? "button" : undefined}
              tabIndex={commentable ? 0 : undefined}
              aria-expanded={commentable ? open : undefined}
              onKeyDown={commentable ? activateOnKey : undefined}
              onClick={commentable ? () => setCommenting((current) => (current === index ? null : index)) : undefined}
            >
              {line || " "}
            </div>
            {open && commentable ? (
              <div className="py-1 pr-2 pb-1.5 pl-5 whitespace-normal">
                <Input
                  className="h-7 text-xs"
                  autoFocus={commenting === index}
                  aria-label={t("Comment for the agent")}
                  placeholder={t("Comment for the agent…")}
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
      {props.truncated ? <div className={classes("px-2.5 py-px whitespace-pre", DIFF_META)}>{t("… diff cut short; reverting still restores the whole file")}</div> : null}
    </pre>
  );
}

/** A diff's header and hunk lines. */
const DIFF_META = "bg-info/6 font-medium text-info";

/** How many lines a change added and removed. */
function Counts(props: { additions: number; deletions: number }) {
  return (
    <span className="inline-flex shrink-0 gap-1 font-mono text-[11px] font-medium">
      {props.additions ? <span className="text-good">+{props.additions}</span> : null}
      {props.deletions ? <span className="text-destructive">−{props.deletions}</span> : null}
    </span>
  );
}

/** An arrow that turns down when what it opens is open. */
function Chevron(props: { down: boolean }) {
  return (
    <svg className={classes("shrink-0 text-muted-foreground transition-transform", props.down && "rotate-90")} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 L6.5 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
