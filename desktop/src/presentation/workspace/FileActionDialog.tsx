import { useEffect, useRef, useState } from "react";
import { t } from "../../domain/i18n.js";
import { Button } from "../ui/base/Button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/base/Dialog.js";
import { Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf } from "../ui/Parts.js";

/** A file operation names its source revision when an open editor or draft depends on it. */
export interface FileAction { kind: "create" | "rename"; path: string; revision?: string | null }

/** Names a file inside the project, with recoverable errors kept beside the input. */
export function FileActionDialog(props: { action: FileAction; onSubmit: (path: string) => Promise<void>; onClose: () => void }) {
  const [path, setPath] = useState(props.action.path);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const rename = props.action.kind === "rename";
  useEffect(() => {
    const start = rename ? props.action.path.lastIndexOf("/") + 1 : props.action.path.length;
    input.current?.setSelectionRange(start, props.action.path.length);
  }, [props.action.path, rename]);
  async function submit() {
    if (!path.trim() || busy) return;
    setBusy(true); setProblem("");
    try { await props.onSubmit(path.trim()); props.onClose(); }
    catch (error) { setProblem(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) props.onClose(); }}>
    <DialogContent initialFocus={input}>
      <DialogHeader><DialogTitle>{rename ? t("Rename file") : t("New file")}</DialogTitle><DialogDescription>{t("Enter a path relative to the project. Existing files are never replaced.")}</DialogDescription></DialogHeader>
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label={t("File path")}><Input ref={input} value={path} onChange={(event) => setPath(event.target.value)} spellCheck={false} autoComplete="off" disabled={busy} /></Field>
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>{t("Cancel")}</Button><Button type="submit" disabled={busy || !path.trim()}>{busy ? t("Saving…") : rename ? t("Rename") : t("Create file")}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
