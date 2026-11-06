import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import type { ModelNode } from "../../domain/research.js";
import type { Screen } from "../shell/navigation.js";
import { Button } from "../ui/base/Button.js";
import { Checkbox } from "../ui/base/Checkbox.js";
import { Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { messageOf } from "../ui/Parts.js";

/** Starts exploration directly from the project's models and configured Python. It runs no model until an action is chosen. */
export function InspectionSessionBuilder(props: { projectId: string; models: ModelNode[]; onCreated: (id: string) => void; notify: (message: string) => void; go: (screen: Screen) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState(t("Exploration"));
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    try { const session = await desktop.research.createInspectionSession(props.projectId, selected, title); props.onCreated(session.id); }
    catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <details className="my-3 rounded-lg border border-border p-3" open={!props.models.length}>
    <summary className="cursor-pointer text-sm font-medium">{t("Start exploration without an experiment")}</summary>
    <p className="my-2 text-xs text-muted-foreground">{t("Choose models and use the Python configured in Environment. Their references and Python path are captured for this session; no training or evaluation run is required.")}</p>
    <Field label={t("Session title")}><Input value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
    <div className="my-2 flex flex-wrap gap-3">{props.models.map((model) => <label key={model.id} className="flex items-center gap-2 text-xs"><Checkbox checked={selected.includes(model.id)} onCheckedChange={(checked) => setSelected((current) => checked ? [...current, model.id] : current.filter((id) => id !== model.id))} />{model.name || model.source} · {model.weightsRevision || t("floating revision")}</label>)}</div>
    <div className="flex flex-wrap gap-2"><Button disabled={busy || !selected.length || selected.length > 32} onClick={() => void start()}>{t("Create inspection session")}</Button><Button variant="ghost" onClick={() => props.go("Lineage")}>{t("Models")}</Button><Button variant="ghost" onClick={() => props.go("Environment")}>{t("Python environment")}</Button></div>
    <p className="mt-2 text-xs text-muted-foreground">{t("Floating weights and changes inside the installed Python environment remain reproducibility limits. Start a new session when a model or interpreter changes.")}</p>
  </details>;
}
