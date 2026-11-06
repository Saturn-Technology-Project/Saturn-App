import { useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import { sampleIdParts,
  changeRereadsList,
  comparisonFactors,
  labelsOf,
  readSamplePages,
  reviewProgress,
  runHasResults,
  runStatusLabel,
  sampleText,
  type AcrossRow,
  type ExperimentRun,
  type OpenTarget,
  type RunLabels,
  type RunSummary,
  type SampleItem,
  type SampleLine,
} from "../../domain/research.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Button } from "../ui/base/Button.js";
import { Card, CardTitle } from "../ui/base/Card.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { classes } from "../ui/base/classes.js";
import { messageOf } from "../ui/Parts.js";
import { Split } from "../ui/Split.js";
import { useRecords } from "../ui/useRecords.js";
import { LookInside } from "./LookInside.js";

const service = desktop.research;
/** The most lines the runtime gives in one page. */
const PAGE_LINES = 200;
const ONLY: { id: "all" | "disputed" | "errors"; label: string }[] = [
  { id: "all", label: t("All") },
  { id: "disputed", label: t("Disputed") },
  { id: "errors", label: t("Errors") },
];
/** The plain set of labels, shown in the interface's language; what is saved stays the word itself. */
const LABEL_NAMES: Record<string, string> = { Correct: t("Correct"), Wrong: t("Wrong"), Invalid: t("Invalid"), Unsure: t("Unsure") };
/** Small quiet text, and a warning in the same size. */
const MUTED = "text-xs text-muted-foreground";
const WARNING = "text-xs text-wait";
/** A screen's title, marked with the screen's color, and a section's heading inside the page. */
const TITLE = "text-(length:--text-title) font-semibold";
const SECTION = "mt-5! mb-2 text-sm font-semibold";
/** A heading with what belongs beside it. */
const HEAD_ROW = "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2";
/** A row of buttons of which one is chosen. */
const SEGMENTS = "flex gap-0.5 rounded-lg border border-border bg-card p-0.5";
/** Code-like text that keeps its line breaks. */
const TEXT = "font-mono text-xs wrap-anywhere whitespace-pre-wrap";
/** A table's heading cell and body cell. */
const HEAD = "px-2 py-1.5 text-left font-medium whitespace-nowrap text-muted-foreground";
const CELL = "border-t border-border p-2 align-top wrap-anywhere";
/** One of the cards about a sample, and a fact in it with its value. */
const ABOUT = "gap-1.5 border-0 bg-panel px-3.5 py-3";
const DETAIL_ROW = "flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-sm wrap-anywhere";
const FACTOR_LABELS: Record<string, string> = { dataset: t("Data"), split: t("Split"), sampleSet: t("Sample set"), scorer: t("Scorer"), promptFormat: t("Prompt format"), chatTemplate: t("Chat template") };

/** The label a person gave a line, if any. */
function labelOf(labels: RunLabels | null, line: SampleLine): string | undefined {
  return Object.values(labels?.labels ?? {}).find((item) => item.sampleId === line.sampleId && item.trial === (line.trial ?? 0) && (item.modelId ?? null) === (line.modelId ?? null))?.label;
}

/** Whether a person's label and the scorer's own word disagree. */
function disputed(labels: RunLabels | null, line: SampleLine): boolean {
  return Object.values(labels?.labels ?? {}).some((item) => item.sampleId === line.sampleId && item.trial === (line.trial ?? 0) && (item.modelId ?? null) === (line.modelId ?? null) && item.agreesWithScorer === false);
}

/** One run's samples, each one across the models and runs that saw it, and a person's label on it, which never overwrites a score. */
export function Samples(props: ScreenProps & { onReview: (item: SampleItem | null) => void }) {
  const projectId = props.project.id;
  const { notify, onReview } = props;
  const { value } = useRecords(async () => ({
    runs: (await service.runs(projectId)).items.filter((run) => runHasResults(run.status)),
    versions: (await service.versions(projectId)).items,
    models: (await service.models(projectId)).items,
    drafts: (await service.experiments(projectId)).items,
  }), notify);
  const [target, setTarget] = useState<Extract<OpenTarget, { kind: "sample" }> | null>(() => service.loadSession(projectId).review ?? null);
  const [runId, setRunId] = useState<string | null>(null);
  const [only, setOnly] = useState<"all" | "disputed" | "errors">("all");
  const [items, setItems] = useState<SampleItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [labels, setLabels] = useState<RunLabels | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [rows, setRows] = useState<AcrossRow[]>([]);
  const [otherLabels, setOtherLabels] = useState<Record<string, RunLabels>>({});
  const [allRuns, setAllRuns] = useState(false);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [inside, setInside] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  const runs = value?.runs ?? [];
  const run = runs.find((item) => item.id === runId) ?? null;
  const choicesFor = (id: string) => labelsOf(value?.drafts.find((draft) => draft.id === runs.find((item) => item.id === id)?.experimentId));
  const modelName = (id: string | null | undefined) => {
    const model = value?.models.find((item) => item.id === id);
    return model ? model.name || model.source : t("Unnamed model");
  };

  // Another screen may have asked for a run, a sample and a filter; otherwise the newest run with results.
  useEffect(() => {
    if (!value) return;
    const wanted = target?.runId && runs.some((item) => item.id === target.runId) ? target.runId : (runs.at(-1)?.id ?? null);
    setRunId(wanted);
    if (target?.only) setOnly(target.only);
    if (target?.sampleId) setSampleId(target.sampleId);
    // A request is followed once; reopening the screen later starts from the newest run again.
    if (target) service.saveSession(projectId, { ...service.loadSession(projectId), review: undefined });
    // Only when the records first arrive or another screen asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value === null, target]);

  useEffect(() => service.onOpen((asked) => asked.kind === "sample" && setTarget(asked)), []);

  // The runtime filters before paging, so a dispute anywhere in the run is found. Old requests cannot replace a new run/filter.
  useEffect(() => {
    const current = ++generation.current;
    const live = () => generation.current === current;
    setItems([]);
    setNextCursor(null);
    setLabels(null);
    setSummary(null);
    setLoadingMore(false);
    if (!runId) return undefined;
    void (async () => {
      try {
        setLoadingMore(true);
        const [labeled, summed] = await Promise.all([service.labels(projectId, runId), service.summary(projectId, runId)]);
        if (!live()) return;
        setLabels(labeled);
        setSummary(summed);
        await readSamplePages((cursor) => service.samples(projectId, runId, cursor, only, PAGE_LINES), {
          live,
          onPage: (page) => {
            setItems((loaded) => [...loaded, ...page.items]);
            setNextCursor(page.next);
          },
        });
      } catch (error) {
        if (live()) notify(messageOf(error));
      } finally {
        if (live()) setLoadingMore(false);
      }
    })();
    return () => { generation.current += 1; };
  }, [notify, only, projectId, runId]);

  useEffect(() => desktop.live.onResearchChange(() => setRefresh((current) => current + 1)), []);

  // A change to the records must not cost the reader their place: labels and counts update, and the list stays as it is
  // unless the change moves what its filter holds, when the new list replaces it whole.
  useEffect(() => {
    if (!refresh || !runId) return undefined;
    let live = true;
    const rereads = changeRereadsList(only);
    const current = rereads ? ++generation.current : generation.current;
    const fresh = () => live && generation.current === current;
    void (async () => {
      try {
        const [labeled, summed] = await Promise.all([service.labels(projectId, runId), service.summary(projectId, runId)]);
        if (!fresh()) return;
        setLabels(labeled);
        setSummary(summed);
        if (!rereads) return;
        const list = await readSamplePages((cursor) => service.samples(projectId, runId, cursor, only, PAGE_LINES), { live: fresh });
        if (!fresh()) return;
        setItems(list.items);
        setNextCursor(list.next);
        setLoadingMore(false);
      } catch (error) {
        if (fresh()) notify(messageOf(error));
      }
    })();
    return () => { live = false; };
    // Only when the records change; a new run or filter is the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // The chosen sample across the models of this run, and across every other run that saw it when asked.
  useEffect(() => {
    if (!runId || !sampleId) {
      setRows([]);
      return;
    }
    let live = true;
    const chosen = allRuns ? runs.map((item) => item.id) : [runId];
    void (async () => {
      try {
        const across = (await service.sampleAcross(projectId, sampleId, chosen)).rows;
        const loaded: Record<string, RunLabels> = {};
        for (const other of chosen.filter((item) => item !== runId)) loaded[other] = await service.labels(projectId, other);
        if (!live) return;
        setRows(across);
        setOtherLabels(loaded);
        const shown = across.find((row) => row.runId === runId)?.samples[0] ?? across.flatMap((row) => row.samples)[0];
        onReview(shown ? { offset: 0, sample: shown } : null);
      } catch (error) {
        if (live) notify(messageOf(error));
      }
    })();
    return () => {
      live = false;
    };
    // `runs` changes identity with every refresh; its ids are what matter and they are in `allRuns`' choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRuns, notify, onReview, projectId, refresh, runId, sampleId]);

  async function moreSamples() {
    if (!runId || nextCursor === null || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await readSamplePages((cursor) => service.samples(projectId, runId, cursor, only, PAGE_LINES), { from: nextCursor, live: () => generation.current === current });
      if (generation.current !== current) return;
      setItems((loaded) => [...loaded, ...page.items]);
      setNextCursor(page.next);
    } catch (error) {
      if (generation.current === current) notify(messageOf(error));
    } finally {
      if (generation.current === current) setLoadingMore(false);
    }
  }

  async function label(forRun: string, line: SampleLine, chosen: string) {
    const current = generation.current;
    try {
      await service.setLabel(projectId, forRun, line, chosen);
      const fresh = await service.labels(projectId, forRun);
      if (generation.current !== current) return;
      if (forRun === runId) setLabels(fresh);
      else setOtherLabels((current) => ({ ...current, [forRun]: fresh }));
    } catch (error) {
      notify(messageOf(error));
    }
  }

  const labelsFor = (forRun: string) => (forRun === runId ? labels : (otherLabels[forRun] ?? null));
  const lines = items.flatMap((item) => (item.sample ? [item.sample] : []));
  const seen = new Set<string>();
  const listed = lines.filter((line) => {
    if (seen.has(line.sampleId)) return false;
    seen.add(line.sampleId);
    return true;
  });
  const current = rows.find((row) => row.runId === runId)?.samples[0] ?? lines.find((line) => line.sampleId === sampleId) ?? null;
  const progress = reviewProgress(summary, labels);

  /** Takes a sample to the Inspect screen, with the run it came from. */
  function openInInspect(line: SampleLine) {
    if (!run || typeof line.input !== "string") return;
    const words = { ...(typeof line.expected === "string" ? { expected: line.expected } : {}), ...(typeof line.alternative === "string" ? { alternative: line.alternative } : {}) };
    service.saveSession(projectId, { ...service.loadSession(projectId), inspect: { runId: run.id, modelId: line.modelId ?? null, input: line.input, ...words } });
    props.go("Inspect");
  }
  const version = (id: string | undefined) => value?.versions.find((item) => item.id === id);
  const runVersion = run ? version(run.versionId) : undefined;
  const factors = comparisonFactors(runVersion?.evaluation, rows.find((row) => row.runId !== runId)?.comparison ?? null);

  const list = (
    <nav className="flex min-w-0 flex-1 flex-col overflow-auto bg-panel px-1.5 pb-2.5" aria-label={t("Samples")} data-tour="samples-list">
      <div className="sticky top-0 z-[1] mb-1 flex flex-none flex-col gap-2 bg-panel px-1 pt-2.5 pb-2">
        <div data-tour="samples-run">
          <Choice label={t("Run")} value={runId ?? ""} options={runs.map((item: ExperimentRun) => ({ value: item.id, label: `${item.id} · ${runStatusLabel(item.status)}` }))} onChange={(chosen) => { setRunId(chosen); setSampleId(null); }} />
        </div>
        <div className={SEGMENTS} role="group" aria-label={t("Which samples")} data-tour="samples-filter">
          {ONLY.map((item) => (
            <Button key={item.id} size="small" variant={only === item.id ? "default" : "ghost"} aria-pressed={only === item.id} className="flex-1" onClick={() => setOnly(item.id)}>
              {item.label}
            </Button>
          ))}
        </div>
      </div>
      {listed.map((line) => {
        const own = lines.filter((other) => other.sampleId === line.sampleId);
        const labeled = Object.values(labels?.labels ?? {}).filter((entry) => entry.sampleId === line.sampleId).length;
        const errors = own.filter((other) => other.error).length;
        const idParts = sampleIdParts(line.sampleId);
        const note = [labeled ? (labeled === 1 ? t("1 label") : t("{count} labels", { count: labeled })) : "", errors ? (errors === 1 ? t("1 error") : t("{count} errors", { count: errors })) : ""].filter(Boolean).join(", ");
        const state = note || t("To review");
        return (
          <button type="button" key={line.sampleId} aria-current={line.sampleId === sampleId ? "true" : undefined} className={classes("flex min-h-7 w-full flex-none items-center gap-2 rounded-md border-0 px-1.5 py-0.5 text-left text-foreground hover:bg-muted", line.sampleId === sampleId && "bg-muted ")} title={`${line.sampleId}: ${state}`} onClick={() => setSampleId(line.sampleId)}>
            {/* Hollow until someone has looked at it. */}
            <span className={classes("size-[7px] flex-none rounded-full border border-muted-foreground", errors ? "border-destructive bg-destructive" : labeled ? "border-good bg-good" : "")} aria-hidden="true" />
            {/* The start gives way to keep the end, where ids tend to differ. */}
            <span className="flex min-w-0 flex-1 font-mono text-xs whitespace-nowrap">
              <span className="min-w-0 flex-[0_1_auto] truncate">{idParts.start}</span>
              <span className="flex-none">{idParts.end}</span>
            </span>
            {note ? <span className="flex-none text-[11px] text-muted-foreground">{note}</span> : <span className="sr-only">{t("To review")}</span>}
          </button>
        );
      })}
      {loadingMore ? <p className={MUTED}>{t("Loading…")}</p> : null}
      {!loadingMore && nextCursor !== null ? (
        <Button variant="ghost" size="small" className="w-fit text-primary" onClick={() => void moreSamples()}>
          {t("More")}
        </Button>
      ) : null}
      {runs.length === 0 && value ? <p className={MUTED}>{t("No run has results yet.")}</p> : null}
      {runs.length && listed.length === 0 ? <p className={MUTED}>{t("Nothing here.")}</p> : null}
    </nav>
  );

  const about = run ? (
    <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-x-6 gap-y-3">
      <Card className={ABOUT}>
        <CardTitle className="mb-1">{t("What differs")}</CardTitle>
        <div className={MUTED}>{allRuns && rows.length > 1 ? t("Between this run's version and the others shown.") : t("Stated by this run's version. Show every run to compare.")}</div>
        {factors.map((factor) => (
          <div className={DETAIL_ROW} key={factor.field}>
            <span className={MUTED}>{FACTOR_LABELS[factor.field] ?? factor.field}</span>
            <span className={factor.state === "differs" ? WARNING : undefined}>
              {factor.state === "differs" ? t("Changed") : factor.state === "missing" ? t("Not stated") : t("Same")}
              {factor.value ? ` · ${factor.value}` : ""}
            </span>
          </div>
        ))}
        <div className={DETAIL_ROW}><span className={MUTED}>{t("Infrastructure errors")}</span><span>{run.infrastructureErrors ?? 0}</span></div>
      </Card>

      <Card className={ABOUT}>
        <CardTitle className="mb-1">{t("Review progress")}</CardTitle>
        <div className="mt-1 h-1.5 overflow-hidden rounded-[3px] bg-muted" role="img" aria-label={t("{labeled} of {total} reviewed", { labeled: progress.labeled, total: progress.total })}>
          <span className="block h-full bg-primary" style={{ width: `${progress.total ? (progress.labeled / progress.total) * 100 : 0}%` }} />
        </div>
        <div className="text-sm">{t("{labeled} of {total} reviewed", { labeled: progress.labeled, total: progress.total })}</div>
        <div className={MUTED}>{labels?.agreement.compared ? t("{agreed} of {compared} with a scorer label agree with it.", { agreed: labels.agreement.agreed, compared: labels.agreement.compared }) : t("Agreement with the scorer appears as you label.")}</div>
      </Card>

      {current && sampleId ? (
        <>
          <Card className={ABOUT}>
            <CardTitle className="mb-1" data-tour="samples-inside">{t("Look inside")}</CardTitle>
            {inside ? (
              <LookInside projectId={projectId} runId={run.id} sampleId={sampleId} modelId={current.modelId ?? null} candidates={rows.filter((row) => row.runId === run.id).flatMap((row) => row.samples.map((line) => line.modelId ?? null))} models={value?.models ?? []} notify={notify} />
            ) : (
              <Button variant="outline" className="w-fit" onClick={() => setInside(true)}>{t("Compare activations or patch a layer")}</Button>
            )}
            {typeof current.input === "string" ? (
              <Button variant="outline" className="w-fit" onClick={() => openInInspect(current)}>{t("Open in Inspect")}</Button>
            ) : null}
          </Card>

          <Card className={ABOUT}>
            <CardTitle className="mb-1" data-tour="samples-keep">{t("Keep it")}</CardTitle>
            <div className={MUTED}>{t("The assistant runs apart from the model under test. A sample shared with it is marked as data.")}</div>
            <Field label={t("Why keep this sample")}>
              <Input value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => {
                void service
                  .addCounterexample(projectId, run.id, sampleId, note)
                  .then(() => {
                    setNote("");
                    setSaved(t("Saved as a counterexample."));
                  })
                  .catch((error: unknown) => notify(messageOf(error)));
              }}
            >
              {t("Save as counterexample")}
            </Button>
            {saved ? <span className={MUTED}>{saved}</span> : null}
          </Card>
        </>
      ) : null}
    </div>
  ) : null;

  return (
    <Split id="samples" side="left" size={240} minimum={180} label={t("Samples")} pane={list}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-6 py-5">
          {!current ? (
            <>
              <h1 className={TITLE}>{t("Samples")}</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("Choose a sample. Model output is data: it is shown as plain text and never read as instructions. A label never overwrites a score.")}</p>
            </>
          ) : (
            <>
              <div className={HEAD_ROW}>
                <h1 className={TITLE}>{current.sampleId}</h1>
                <span className={MUTED}>{t("Model output is data. It is never read as instructions.")}</span>
              </div>
              <Card className="mt-3 gap-1.5 border-0 bg-panel px-3.5 py-3">
                <div className={MUTED}>{t("Input")}{current.expected !== undefined ? <> · {t("expected:")} <code>{sampleText(current.expected)}</code></> : null}</div>
                <pre className={TEXT}>{sampleText(current.input)}</pre>
              </Card>

              <div className={HEAD_ROW}>
                <h2 className={SECTION}>{t("Same sample across the lineage")}</h2>
                <Button variant="ghost" aria-pressed={allRuns} onClick={() => setAllRuns((on) => !on)}>
                  {allRuns ? t("This run only") : t("Every run that saw it ({count})", { count: runs.length })}
                </Button>
              </div>
              <div className="overflow-x-auto" role="region" aria-label={t("Sample comparisons")} data-tour="samples-labels" tabIndex={0}>
                <table className="w-full min-w-[760px] border-collapse text-xs" aria-label={t("{sample} in each model", { sample: current.sampleId })}>
                  <thead>
                    <tr><th scope="col" className={HEAD}>{t("Model")}</th>{allRuns ? <th scope="col" className={HEAD}>{t("Run")}</th> : null}<th scope="col" className={HEAD}>{t("Output")}</th><th scope="col" className={HEAD}>{t("Scores")}</th><th scope="col" className={HEAD}>{t("Scorer")}</th><th scope="col" className={HEAD}>{t("Your label")}</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((row) =>
                      row.samples.length === 0 ? (
                        <tr key={row.runId}><td colSpan={allRuns ? 7 : 6} className={classes(CELL, MUTED)}><code>{row.runId}</code> {t("has no such sample.")}</td></tr>
                      ) : (
                        row.samples.map((line) => (
                          <tr key={`${row.runId}-${line.trial ?? 0}-${line.modelId ?? ""}`}>
                            <td className={CELL}>{modelName(line.modelId)}{row.comparison.result !== "comparable" && row.runId !== runId ? <div className={WARNING}>{t("Not measured the same way")}</div> : null}</td>
                            {allRuns ? <td className={CELL}><code>{row.runId}</code> <span className={MUTED}>v{version(row.versionId)?.number ?? "?"}</span></td> : null}
                            <td className={CELL}><pre className={TEXT}>{sampleText(line.output)}</pre></td>
                            <td className={CELL}><div className={TEXT}>{line.scores ? Object.entries(line.scores).map(([name, score]) => <div key={name}>{name} = {String(score)}</div>) : <span className={MUTED}>{t("None")}</span>}</div></td>
                            <td className={CELL}>
                              {line.scorerLabel ?? <span className={MUTED}>{t("No word")}</span>}
                              {line.error ? <div className={WARNING}>{t("{kind} error", { kind: line.error.kind })}{line.error.message ? `: ${line.error.message}` : ""}</div> : null}
                            </td>
                            <td className={CELL}>
                              <div className={classes(SEGMENTS, "w-max")} role="group" aria-label={t("Your label for {model} in {run}", { model: modelName(line.modelId), run: row.runId })}>
                                {choicesFor(row.runId).map((item) => {
                                  const chosen = labelOf(labelsFor(row.runId), line) === item;
                                  return (
                                    <Button key={item} size="small" variant={chosen ? "default" : "ghost"} aria-pressed={chosen} onClick={() => void label(row.runId, line, item)}>
                                      {LABEL_NAMES[item] ?? item}
                                    </Button>
                                  );
                                })}
                              </div>
                              {disputed(labelsFor(row.runId), line) ? <div className={WARNING}>{t("Disagrees with the scorer. Both are kept.")}</div> : null}
                            </td>
                          </tr>
                        ))
                      ),
                    )}
                  </tbody>
                </table>
              </div>

              <h2 className={SECTION}>{t("Scoring rationale")}</h2>
              <Card className="gap-1.5 border-0 bg-panel px-3.5 py-3">
                {current.scorerLabel ? <div className="text-sm">{t("The scorer called it")} <strong>{current.scorerLabel}</strong>{current.scores ? ` ${t("from {scores}", { scores: Object.entries(current.scores).map(([name, score]) => `${name} = ${String(score)}`).join(", ") })}` : ""}.</div> : null}
                {!current.scorerLabel && current.scores ? <div className="text-sm">{t("Scores: {scores}. The scorer gave no word for its result.", { scores: Object.entries(current.scores).map(([name, score]) => `${name} = ${String(score)}`).join(", ") })}</div> : null}
                {current.error ? <div className={WARNING}>{t("{kind} error: {message}.", { kind: current.error.kind, message: current.error.message ?? t("no message") })} {current.error.kind === "infrastructure" ? t("Excluded from the score.") : t("Counted as an error, not as a score.")}</div> : null}
                {!current.scores && !current.error ? <div className={MUTED}>{t("No score on this line.")}</div> : null}
                <div className={MUTED}>{t("A rationale written by the program, as a scorerLabel on the line, is shown here. The score itself is never changed by a label.")}</div>
              </Card>
            </>
          )}
          {about}
        </div>
      </div>
    </Split>
  );
}
