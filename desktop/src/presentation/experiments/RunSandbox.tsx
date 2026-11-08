import { useEffect, useState } from "react";
import { t } from "../../domain/i18n.js";
import { sandboxOf, type ExperimentDraft, type SandboxSettings } from "../../domain/research.js";
import { Button } from "../ui/base/Button.js";
import { Checkbox } from "../ui/base/Checkbox.js";
import { Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";

const MUTED = "text-xs text-muted-foreground";
const SECTION = "mt-5! mb-2 text-sm font-semibold";

/** The names in a comma separated list, without blanks or repeats. */
function namesIn(value: string): string[] {
  return [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
}

/** The seeds in a comma separated list: whole numbers as numbers, anything else as the text it is. */
function seedsIn(value: string): (number | string)[] {
  return namesIn(value).map((seed) => (/^-?\d{1,15}$/.test(seed) ? Number(seed) : seed));
}

/**
 * The sandbox an experiment's runs get: whether its program is isolated, whether it may use the network, and which
 * environment variables it is given. Saved on the experiment and frozen into the next version.
 */
export function RunSandbox(props: { draft: ExperimentDraft; save: (fields: { sandbox: SandboxSettings; envNames: string[]; seeds: (number | string)[] }) => Promise<void> }) {
  const saved = sandboxOf(props.draft);
  const [isolated, setIsolated] = useState(saved.isolated);
  const [network, setNetwork] = useState(saved.network);
  const [names, setNames] = useState((props.draft.envNames ?? []).join(", "));
  const [seeds, setSeeds] = useState((props.draft.seeds ?? []).join(", "));

  useEffect(() => {
    const current = sandboxOf(props.draft);
    setIsolated(current.isolated);
    setNetwork(current.network);
    setNames((props.draft.envNames ?? []).join(", "));
    setSeeds((props.draft.seeds ?? []).join(", "));
  }, [props.draft]);

  const changed =
    isolated !== saved.isolated || network !== saved.network || namesIn(names).join(",") !== (props.draft.envNames ?? []).join(",") || seedsIn(seeds).join(",") !== (props.draft.seeds ?? []).join(",");

  return (
    <>
      <h2 className={SECTION}>{t("Sandbox")}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {t("A run's program reads its snapshot and writes only to SATURN_RUN_OUTPUT, its temporary folder and the shared caches. The project, Saturn's data and credential folders such as ~/.ssh are hidden from it. Changes apply from the next version.")}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={isolated} onCheckedChange={(checked) => setIsolated(checked === true)} />
          {t("Run in the sandbox")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={isolated && network} disabled={!isolated} onCheckedChange={(checked) => setNetwork(checked === true)} />
          {t("Allow network access")}
        </label>
        {!isolated ? <div className="text-xs text-wait">{t("Without the sandbox the program can read and write anything your account can, and gets every environment variable, including keys.")}</div> : null}
        <Field label={t("Environment variables to pass, comma separated")} className="max-w-xl">
          <Input value={names} placeholder="HF_TOKEN, OPENAI_API_KEY" disabled={!isolated} onChange={(event) => setNames(event.target.value)} />
        </Field>
        <div className={MUTED}>{t("Only these, and variables that say where things are (PATH, HOME, HF_HOME, CUDA_VISIBLE_DEVICES and the like), reach the program. Their names are recorded with each run, never their values.")}</div>
        <Field label={t("Seeds, comma separated")} className="max-w-xl">
          <Input value={seeds} placeholder="0, 1, 2" onChange={(event) => setSeeds(event.target.value)} />
        </Field>
        <div className={MUTED}>{t("Passed to the program as SATURN_RUN_SEED (the first) and SATURN_RUN_SEEDS (all), and frozen into each version. Whether the program applied them is for its report to say; the run's evidence shows both.")}</div>
        <div>
          <Button variant="outline" disabled={!changed} onClick={() => void props.save({ sandbox: { isolated, network }, envNames: namesIn(names), seeds: seedsIn(seeds) })}>
            {t("Save")}
          </Button>
        </div>
      </div>
    </>
  );
}
