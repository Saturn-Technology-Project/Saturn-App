import { useState } from "react";
import { desktop } from "../../application/desktop.js";
import { comparisonText, type ExperimentRun, type PairedComparison, type PairedComparisonRequest } from "../../domain/research.js";
import type { Screen } from "../shell/navigation.js";
import { Button } from "../ui/base/Button.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { messageOf } from "../ui/Parts.js";
import { useRecords } from "../ui/useRecords.js";

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
  const options = runs.map((run) => ({ value: run.id, label: `${new Date(run.createdAt).toLocaleString()} · ${run.id}${run.imported ? " · imported" : ""}` }));

  async function compare(next: PairedComparisonRequest, append = false) {
    setBusy(true);
    try {
      const answer = await desktop.research.pairedComparison(props.projectId, next);
      setRequest(next);
      setResult((current) => append && current ? { ...answer, items: [...current.items, ...answer.items] } : answer);
      if (answer.saved) { props.notify(`Saved ${answer.saved.members.length} regressions in “${answer.saved.title}”, including samples beyond this page.`); void refreshSets(); }
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
    <summary className="cursor-pointer text-sm font-medium">Compare behavior changes</summary>
    <p className="my-2 text-xs text-muted-foreground">Pair the same input and trial. Select a model when a run contains several. Positive delta means right minus left; choose whether a higher score is better.</p>
    <div className="flex flex-wrap gap-2">
      <Choice label="Left run" className="min-w-48 flex-1" value={left || runs.at(-2)?.id || runs[0]?.id || ""} options={options} onChange={setLeft} />
      <Choice label="Right run" className="min-w-48 flex-1" value={right || runs.at(-1)?.id || ""} options={options} onChange={setRight} />
      <Field label="Left modelId (optional)" className="min-w-32 flex-1"><Input value={leftModel} onChange={(event) => setLeftModel(event.target.value)} /></Field>
      <Field label="Right modelId (optional)" className="min-w-32 flex-1"><Input value={rightModel} onChange={(event) => setRightModel(event.target.value)} /></Field>
    </div>
    <div className="my-2 flex flex-wrap items-end gap-2">
      <Field label="Numeric scorer"><Input value={scorer} placeholder="accuracy" onChange={(event) => setScorer(event.target.value)} /></Field>
      <Choice label="Better score" value={direction} options={[{ value: "higher", label: "Higher" }, { value: "lower", label: "Lower" }]} onChange={setDirection} />
      <Field label="Slice field on source sample"><Input value={sliceField} onChange={(event) => setSliceField(event.target.value)} /></Field>
      <Button disabled={busy || !scorer.trim() || !runs.length} onClick={start}>Compare</Button>
    </div>
    {sets?.items.length ? <details className="my-2 text-xs"><summary>Saved regression sets ({sets.items.length})</summary>{sets.items.map((set) => <div key={set.id} className="my-2"><strong>{set.title}</strong> · {set.members.length} saved members <Button variant="ghost" size="small" disabled={busy} onClick={() => { setFilter("all"); setSlice(set.request.slice ?? "__all"); void compare(set.request); }}>Recompute original comparison</Button><details><summary>Saved membership</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(set.members, null, 2)}</pre></details></div>)}</details> : null}
    {result && request ? <div aria-live="polite">
      <Notice tone={result.comparison.result === "comparable" ? "good" : "wait"}>{comparisonText(result.comparison)}. {result.comparison.result !== "comparable" ? "Differences below are descriptive; no inference interval is shown." : ""}</Notice>
      <p className="my-2 text-sm">Prompt-weighted mean delta: <strong>{result.summary.meanDelta?.toPrecision(4) ?? "—"}</strong>{result.summary.interval95 ? `; conservative 95% interval [${result.summary.interval95.map((value) => value.toPrecision(4)).join(", ")}]` : "; interval unavailable"}.</p>
      <p className="text-xs text-muted-foreground">{result.summary.paired} valid pairs across {result.summary.independentSamples} sample IDs; {result.summary.improved} improved, {result.summary.regressed} regressed, {result.summary.unchanged} unchanged. Missing left: {result.summary.missingLeft}; missing right: {result.summary.missingRight}; excluded: {result.summary.excluded}.</p>
      <details className="my-2 text-xs text-muted-foreground"><summary>Method and assumptions</summary>{result.note}</details>
      <div className="my-2 flex flex-wrap items-end gap-2">
        <Choice label="Show" value={filter} options={["all", "improved", "regressed", "unchanged", "excluded", "missing_left", "missing_right"].map((value) => ({ value, label: value.replaceAll("_", " ") }))} onChange={(value) => { setFilter(value); filtered(value, slice); }} />
        <Choice label="Slice" value={slice} options={[{ value: "__all", label: "All slices" }, ...result.slices.map((group) => ({ value: group.name, label: `${group.name} · n=${group.independentSamples}, Δ=${group.meanDelta?.toPrecision(3) ?? "—"}` }))]} onChange={(value) => { setSlice(value); filtered(filter, value); }} />
        <Button variant="outline" disabled={busy || !result.summary.regressed} onClick={() => void compare({ ...request, save: true, title: `Regressions: ${request.scorer}`, cursor: 0 })}>Save regression set</Button>
      </div>
      <div className="max-h-96 overflow-auto" tabIndex={0} role="region" aria-label="Paired sample changes"><table className="w-full border-collapse text-xs"><thead><tr>{["Sample", "Change", "Delta", "Slice", "Evidence"].map((name) => <th key={name} className="p-2 text-left font-medium">{name}</th>)}</tr></thead><tbody>
        {result.items.map((row) => <tr key={`${row.sampleId}:${row.trial}`}><td className="border-t border-border p-2 font-mono">{row.sampleId} · {row.trial}</td><td className="border-t border-border p-2">{row.change}{row.reason ? ` (${row.reason})` : ""}</td><td className="border-t border-border p-2">{row.delta?.toPrecision(4) ?? "—"}</td><td className="border-t border-border p-2">{row.slice}</td><td className="border-t border-border p-2"><Button variant="ghost" size="small" onClick={() => { desktop.research.open(props.projectId, { kind: "sample", runId: row.right ? request.right.runId : request.left.runId, sampleId: row.sampleId }); props.go("Samples"); }}>Open sample</Button></td></tr>)}
      </tbody></table></div>
      <p className="my-1 text-xs text-muted-foreground">{result.items.length} of {result.total} rows shown for this filter. Saved sets include every regression in the selected slice.</p>
      {result.next !== null ? <Button variant="outline" disabled={busy} onClick={() => void compare({ ...request, cursor: result.next ?? 0, save: false }, true)}>Load more changes</Button> : null}
    </div> : null}
  </details>;
}
