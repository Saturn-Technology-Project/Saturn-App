import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import { comparisonText, type ExperimentRun, type PairedComparison, type PairedComparisonRequest } from "../../domain/research.js";
import type { Screen } from "../shell/navigation.js";
import { Button } from "../ui/base/Button.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

/** What a paired change, or a filter on them, is called. */
const CHANGE_LABELS: Record<string, string> = { all: t("All"), improved: t("Improved"), regressed: t("Regressed"), unchanged: t("Unchanged"), excluded: t("Excluded"), missing_left: t("Missing left"), missing_right: t("Missing right") };

/** Paired changes are an entry into the original samples, with missingness and uncertainty kept visible. */
export function ComparisonPanel(props: { projectId: string; runs: ExperimentRun[]; notify: (text: string) => void; go: (screen: Screen) => void }) {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [leftModel, setLeftModel] = useState("");
  const [rightModel, setRightModel] = useState("");
  const [scorer, setScorer] = useState("");
  const [direction, setDirection] = useState("higher");
  const [sliceField, setSliceField] = useState("category");
  const [result, setResult] = useState<PairedComparison | null>(null);
  const [request, setRequest] = useState<PairedComparisonRequest | null>(null);
  const [filter, setFilter] = useState("all");
  const [slice, setSlice] = useState("__all");
  const [busy, setBusy] = useState(false);
  const { value: sets, refresh: refreshSets } = useRecords(() => desktop.research.counterexampleSets(props.projectId), props.notify);
  const runs = props.runs.filter((run) => !["starting", "running", "stopping"].includes(run.status));
  const options = runs.map((run) => ({ value: run.id, label: `${new Date(run.createdAt).toLocaleString()} · ${run.id}${run.imported ? ` · ${t("imported")}` : ""}` }));

  async function compare(next: PairedComparisonRequest, append = false) {
    setBusy(true);
    try {
      const answer = await desktop.research.pairedComparison(props.projectId, next);
      setRequest(next);
      setResult((current) => append && current ? { ...answer, items: [...current.items, ...answer.items] } : answer);
      if (answer.saved) { props.notify(t("Saved {count} regressions in “{title}”, including samples beyond this page.", { count: answer.saved.members.length, title: answer.saved.title })); void refreshSets(); }
    } catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }

  function start() {
    setFilter("all"); setSlice("__all");
    void compare({ left: { runId: left || runs.at(-2)?.id || runs[0]?.id || "", ...(leftModel ? { modelId: leftModel } : {}) }, right: { runId: right || runs.at(-1)?.id || "", ...(rightModel ? { modelId: rightModel } : {}) }, scorer: scorer.trim(), higherIsBetter: direction === "higher", sliceField: sliceField.trim() || "category" });
  }

  function filtered(only: string, group: string) {
    if (!request) return;
    const next = { ...request, only, cursor: 0, save: false };
    delete next.slice;
    if (group !== "__all") next.slice = group;
    void compare(next);
  }

  return <details className="my-3 rounded-lg border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">{t("Compare behavior changes")}</summary>
    <p className="my-2 text-xs text-muted-foreground">{t("Pair the same input and trial. Select a model when a run contains several. Positive delta means right minus left; choose whether a higher score is better.")}</p>
    <div className="flex flex-wrap gap-2">
      <Choice label={t("Left run")} className="min-w-48 flex-1" value={left || runs.at(-2)?.id || runs[0]?.id || ""} options={options} onChange={setLeft} />
      <Choice label={t("Right run")} className="min-w-48 flex-1" value={right || runs.at(-1)?.id || ""} options={options} onChange={setRight} />
      <Field label={t("Left modelId (optional)")} className="min-w-32 flex-1"><Input value={leftModel} onChange={(event) => setLeftModel(event.target.value)} /></Field>
      <Field label={t("Right modelId (optional)")} className="min-w-32 flex-1"><Input value={rightModel} onChange={(event) => setRightModel(event.target.value)} /></Field>
    </div>
    <div className="my-2 flex flex-wrap items-end gap-2">
      <Field label={t("Numeric scorer")}><Input value={scorer} placeholder="accuracy" onChange={(event) => setScorer(event.target.value)} /></Field>
      <Choice label={t("Better score")} value={direction} options={[{ value: "higher", label: t("Higher") }, { value: "lower", label: t("Lower") }]} onChange={setDirection} />
      <Field label={t("Slice field on source sample")}><Input value={sliceField} onChange={(event) => setSliceField(event.target.value)} /></Field>
      <Button disabled={busy || !scorer.trim() || !runs.length} onClick={start}>{t("Compare")}</Button>
    </div>
    {sets?.items.length ? <details className="my-2 text-xs"><summary>{t("Saved regression sets ({count})", { count: sets.items.length })}</summary>{sets.items.map((set) => <div key={set.id} className="my-2"><strong>{set.title}</strong> · {t("{count} saved members", { count: set.members.length })} <Button variant="ghost" size="small" disabled={busy} onClick={() => { setFilter("all"); setSlice(set.request.slice ?? "__all"); void compare(set.request); }}>{t("Recompute original comparison")}</Button><details><summary>{t("Saved membership")}</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(set.members, null, 2)}</pre></details></div>)}</details> : null}
    {result && request ? <div aria-live="polite">
      <Notice tone={result.comparison.result === "comparable" ? "good" : "wait"}>{comparisonText(result.comparison)}. {result.comparison.result !== "comparable" ? t("Differences below are descriptive; no inference interval is shown.") : ""}</Notice>
      <p className="my-2 text-sm">{t("Prompt-weighted mean delta:")} <strong>{result.summary.meanDelta?.toPrecision(4) ?? "—"}</strong>{result.summary.interval95 ? t("; conservative 95% interval [{interval}]", { interval: result.summary.interval95.map((value) => value.toPrecision(4)).join(", ") }) : t("; interval unavailable")}.</p>
      <p className="text-xs text-muted-foreground">{t("{paired} valid pairs across {samples} sample IDs; {improved} improved, {regressed} regressed, {unchanged} unchanged. Missing left: {missingLeft}; missing right: {missingRight}; excluded: {excluded}.", { paired: result.summary.paired, samples: result.summary.independentSamples, improved: result.summary.improved, regressed: result.summary.regressed, unchanged: result.summary.unchanged, missingLeft: result.summary.missingLeft, missingRight: result.summary.missingRight, excluded: result.summary.excluded })}</p>
      <details className="my-2 text-xs text-muted-foreground"><summary>{t("Method and assumptions")}</summary>{result.note}</details>
      <div className="my-2 flex flex-wrap items-end gap-2">
        <Choice label={t("Show")} value={filter} options={["all", "improved", "regressed", "unchanged", "excluded", "missing_left", "missing_right"].map((value) => ({ value, label: CHANGE_LABELS[value] }))} onChange={(value) => { setFilter(value); filtered(value, slice); }} />
        <Choice label={t("Slice")} value={slice} options={[{ value: "__all", label: t("All slices") }, ...result.slices.map((group) => ({ value: group.name, label: `${group.name} · n=${group.independentSamples}, Δ=${group.meanDelta?.toPrecision(3) ?? "—"}` }))]} onChange={(value) => { setSlice(value); filtered(filter, value); }} />
        <Button variant="outline" disabled={busy || !result.summary.regressed} onClick={() => void compare({ ...request, save: true, title: t("Regressions: {scorer}", { scorer: request.scorer }), cursor: 0 })}>{t("Save regression set")}</Button>
      </div>
      <div className="max-h-96 overflow-auto" tabIndex={0} role="region" aria-label={t("Paired sample changes")}><table className="w-full border-collapse text-xs"><thead><tr>{[t("Sample"), t("Change"), t("Delta"), t("Slice"), t("Evidence")].map((name) => <th key={name} className="p-2 text-left font-medium">{name}</th>)}</tr></thead><tbody>
        {result.items.map((row) => <tr key={`${row.sampleId}:${row.trial}`}><td className="border-t border-border p-2 font-mono">{row.sampleId} · {row.trial}</td><td className="border-t border-border p-2">{CHANGE_LABELS[row.change] ?? row.change}{row.reason ? ` (${row.reason})` : ""}</td><td className="border-t border-border p-2">{row.delta?.toPrecision(4) ?? "—"}</td><td className="border-t border-border p-2">{row.slice}</td><td className="border-t border-border p-2"><Button variant="ghost" size="small" onClick={() => { desktop.research.open(props.projectId, { kind: "sample", runId: row.right ? request.right.runId : request.left.runId, sampleId: row.sampleId }); props.go("Samples"); }}>{t("Open sample")}</Button></td></tr>)}
      </tbody></table></div>
      <p className="my-1 text-xs text-muted-foreground">{t("{shown} of {total} rows shown for this filter. Saved sets include every regression in the selected slice.", { shown: result.items.length, total: result.total })}</p>
      {result.next !== null ? <Button variant="outline" disabled={busy} onClick={() => void compare({ ...request, cursor: result.next ?? 0, save: false }, true)}>{t("Load more changes")}</Button> : null}
    </div> : null}
  </details>;
}
