import { useState } from "react";
import { t } from "../../domain/i18n.js";
import { Button } from "../ui/base/Button.js";
import { Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";

/**
 * The experiment's name, which can be changed at any time: its versions and runs stay with it, since they point to it
 * by id. The new name is saved on Enter or with the button, Escape puts the saved one back, and a blank name is never
 * sent. Keyed by the experiment's revision where it is used, so a saved or outside change shows the name on record.
 */
export function ExperimentTitle(props: { title: string; onRename: (title: string) => Promise<void> }) {
  const [text, setText] = useState(props.title);
  const [saving, setSaving] = useState(false);
  const name = text.trim();
  const changed = name !== props.title;
  async function save() {
    if (!changed || !name || saving) return;
    setSaving(true);
    try {
      await props.onRename(name);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="mt-3 flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Field label={t("Experiment name")} className="flex-1" hint={!name ? t("An experiment needs a name.") : undefined}>
        <Input value={text} aria-invalid={!name} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setText(props.title); }} />
      </Field>
      {changed ? <Button type="submit" disabled={!name || saving}>{t("Rename")}</Button> : null}
    </form>
  );
}
