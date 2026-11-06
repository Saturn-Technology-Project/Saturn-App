import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import type { ExperimentDraft } from "../../domain/research.js";
import { Button } from "../ui/base/Button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/base/Dialog.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf } from "../ui/Parts.js";

/**
 * Deletes an experiment after asking: it moves, with its versions, runs and labels, into the records' trash folder,
 * where it can be found again. The runtime refuses while a run is going or while other records refer to it.
 */
export function DeleteExperiment(props: { projectId: string; experiment: ExperimentDraft; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await desktop.research.deleteExperiment(props.projectId, props.experiment);
      setAsking(false);
      props.onDeleted();
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="ghost" className="text-muted-foreground" onClick={() => { setProblem(null); setAsking(true); }}>{t("Delete experiment")}</Button>
      <Dialog open={asking} onOpenChange={(open) => { if (!open) setAsking(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Delete “{title}”?", { title: props.experiment.title })}</DialogTitle>
            <DialogDescription>{t("The experiment, its versions, runs and labels move to .saturn/research/trash in the project. Nothing is erased, and you can move them back by hand.")}</DialogDescription>
          </DialogHeader>
          {problem ? <Notice tone="bad">{problem}</Notice> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsking(false)}>{t("Cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? t("Deleting…") : t("Delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
