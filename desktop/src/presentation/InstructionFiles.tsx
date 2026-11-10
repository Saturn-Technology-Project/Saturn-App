import { useCallback, useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import { t } from "../domain/i18n";
import type { ProjectInstructions } from "../domain/model";
import { Button } from "./ui/base/Button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/base/Dialog.js";
import { Notice } from "./ui/base/Notice.js";

/** A project's instruction files, read again whenever its files or records may have changed. */
export function useInstructions(projectId: string | undefined): { instructions: ProjectInstructions | null; refresh: () => Promise<void>; set: (next: ProjectInstructions) => void } {
  const [instructions, setInstructions] = useState<ProjectInstructions | null>(null);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      setInstructions(await desktop.projects.instructions(projectId));
    } catch {
      // A project without access, or a runtime that is restarting: nothing to say about its files.
      setInstructions(null);
    }
  }, [projectId]);
  useEffect(() => {
    void refresh();
    // An agent's turn can write a rule or a skill: read again after every change.
    const stopRuns = desktop.live.onChange(() => void refresh());
    const stopRecords = desktop.live.onResearchChange(() => void refresh());
    return () => {
      stopRuns();
      stopRecords();
    };
  }, [refresh]);
  return { instructions, refresh, set: setInstructions };
}

/**
 * What a project's instruction files say, each in full, and Allow (when they are held) or Withdraw. They came with the
 * folder, so they reach agents only once the user has read and allowed exactly these; any change asks again.
 */
export function InstructionsReview(props: { projectId: string; instructions: ProjectInstructions; onChanged: (next: ProjectInstructions) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const { instructions } = props;

  async function decide(allow: boolean) {
    setBusy(true);
    try {
      props.onChanged(allow ? await desktop.projects.approveInstructions(props.projectId, instructions.fingerprint) : await desktop.projects.revokeInstructions(props.projectId));
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : t("Could not save"));
    } finally {
      setBusy(false);
    }
  }

  if (!instructions.files.length) return <p className="m-0 text-xs text-muted-foreground">{t("This project has no instruction files or skills of its own.")}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-xs text-muted-foreground">
        {instructions.approved
          ? t("Agents follow these files. A change to any of them, by anyone, holds them again until you allow it.")
          : t("These files came with the folder. Agents get none of them until you allow them, so read them first: they can tell an agent what to do, and should never ask it to send files, keys or tokens anywhere.")}
      </p>
      <div className="flex flex-col gap-1">
        {instructions.files.map((file) => (
          <details key={file.path} className="rounded-md border border-border bg-background/40 px-2.5 py-1.5">
            <summary className="cursor-pointer text-xs">
              <code>{file.path}</code> <span className="text-muted-foreground">{t("{count} characters", { count: file.chars })}</span>
            </summary>
            <pre className="mt-1.5 mb-0 max-h-64 overflow-auto font-mono text-[11.5px] [overflow-wrap:anywhere] whitespace-pre-wrap">{file.content}</pre>
          </details>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {instructions.approved ? (
          <Button type="button" variant="outline" size="small" disabled={busy} onClick={() => void decide(false)}>{t("Withdraw")}</Button>
        ) : (
          <Button type="button" size="small" disabled={busy} onClick={() => void decide(true)}>{t("Allow these files")}</Button>
        )}
      </div>
    </div>
  );
}

/** A line in the assistant's panel while a project's instruction files are held, with a way to read and allow them. */
export function InstructionsNotice(props: { projectId: string; onError: (message: string) => void }) {
  const { instructions, set } = useInstructions(props.projectId);
  const [open, setOpen] = useState(false);
  if (!instructions || instructions.approved || !instructions.files.length) return null;
  return (
    <>
      <Notice tone="wait" className="mx-2 mt-2 flex flex-wrap items-center justify-between gap-2 whitespace-normal">
        <span className="min-w-0 flex-[1_1_200px]">{t("This project's instruction files are held until you review them: {files}", { files: instructions.files.map((file) => file.path).join(", ") })}</span>
        <Button type="button" variant="outline" size="small" onClick={() => setOpen(true)}>{t("Review")}</Button>
      </Notice>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("Instruction files")}</DialogTitle>
            <DialogDescription>{t("Files in this project that tell agents how to work in it.")}</DialogDescription>
          </DialogHeader>
          <InstructionsReview
            projectId={props.projectId}
            instructions={instructions}
            onChanged={(next) => {
              set(next);
              if (next.approved) setOpen(false);
            }}
            onError={props.onError}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t("Close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
