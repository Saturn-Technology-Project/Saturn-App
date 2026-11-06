import { useState } from "react";
import { Choice } from "../ui/base/Field.js";
import { t } from "../../domain/i18n.js";
import { comparisonText, lineageOrder, scoreText, type Comparison, type ExperimentRun, type FrozenVersion, type ModelNode, type RunSummary } from "../../domain/research.js";

/** One bar: a model in a run, and whether it measured the same way as the first bar. */
interface Bar {
  key: string;
  label: string;
  version: number;
  mean: number | null;
  count: number;
  errors: number;
  comparison: Comparison | null;
}

/**
 * Each model's mean score, in the order the runs happened. Only what measured like the newest run shares the axis: anything else
 * is listed under it with what differs, so a difference in method never reads as a difference in the model.
 */
export function ScoreChart(props: { projectId: string; runs: ExperimentRun[]; versions: FrozenVersion[]; models: ModelNode[]; summaries: RunSummary[]; comparisons: Record<string, Comparison> }) {
  const { versions, models, summaries, comparisons } = props;
  const [scorer, setScorer] = useState<string | null>(null);

  const scorers = [...new Set(summaries.flatMap((summary) => summary.models.flatMap((model) => Object.keys(model.scores))))];
  const chosen = scorer && scorers.includes(scorer) ? scorer : scorers[0];
  if (!chosen) return null;

  const order = new Map(lineageOrder(models).map((item, position) => [item.model.id, position]));
  const changedInputs = (runId: string) => props.runs.find((run) => run.id === runId)?.inputsChanged ?? [];
  const bars: Bar[] = summaries.flatMap((summary) =>
    [...summary.models].sort((left, right) => (order.get(left.modelId ?? "") ?? Infinity) - (order.get(right.modelId ?? "") ?? Infinity)).map((model) => {
      const node = models.find((item) => item.id === model.modelId);
      return {
        key: `${summary.runId}:${model.modelId ?? ""}`,
        // An imported score says so beside its name, so it is never read as one Saturn measured.
        label: props.runs.find((run) => run.id === summary.runId)?.imported ? t("{name} (imported)", { name: node?.name ?? node?.source ?? model.modelId ?? t("This run") }) : (node?.name ?? node?.source ?? model.modelId ?? t("This run")),
        version: versions.find((version) => version.id === summary.versionId)?.number ?? 0,
        mean: model.scores[chosen]?.mean ?? null,
        count: model.scores[chosen]?.count ?? 0,
        errors: Object.values(model.errors).reduce((sum, count) => sum + count, 0),
        // The newest run's version is what the rest are compared with, whatever it states. A run whose inputs changed
        // while it ran stands apart: it no longer measured what its version froze.
        comparison: changedInputs(summary.runId).length
          ? { result: "not_comparable" as const, differs: [t("inputs, changed during the run ({paths})", { paths: changedInputs(summary.runId).join(", ") })], missing: [] }
          : summary.versionId === summaries.at(-1)?.versionId ? { result: "comparable" as const, differs: [], missing: [] } : (comparisons[summary.versionId] ?? null),
      };
    }),
  );
  const shared = bars.filter((bar) => bar.comparison?.result === "comparable");
  const apart = bars.filter((bar) => bar.comparison?.result !== "comparable");
  const widest = Math.max(...shared.map((bar) => Math.abs(bar.mean ?? 0)), Number.EPSILON);

  return (
    <>
      <h2 className="mt-5! mb-2 text-sm font-semibold">{t("Mean score")}</h2>
      <figure className="m-0 flex flex-col gap-2.5 rounded-lg bg-panel px-3.5 py-3" data-tour="experiments-score" aria-label={t("Mean {scorer} of each model", { scorer: chosen })}>
        {scorers.length > 1 ? (
          <Choice label={t("Scorer")} className="max-w-[220px]" value={chosen} options={scorers.map((name) => ({ value: name, label: name }))} onChange={setScorer} />
        ) : (
          <figcaption className="text-xs text-muted-foreground">{t("{scorer}, measured the same way as the newest run", { scorer: chosen })}</figcaption>
        )}
        <div className="flex flex-col gap-1">
          {shared.map((bar) => (
            <div className="grid min-h-[26px] grid-cols-[minmax(90px,200px)_minmax(60px,1fr)_56px_minmax(60px,110px)] items-center gap-2 text-xs" key={bar.key} title={t("{label}, v{version}: {score} from {count} samples", { label: bar.label, version: bar.version, score: scoreText(bar.mean), count: bar.count })}>
              <span className="truncate">
                {bar.label} <span className="text-muted-foreground">v{bar.version}</span>
              </span>
              <span className="block h-3.5 rounded-[3px] bg-muted">
                <span className="block h-3.5 rounded-r-[4px] bg-primary" style={{ width: `${(Math.abs(bar.mean ?? 0) / widest) * 100}%` }} />
              </span>
              <span className="text-right font-mono">{scoreText(bar.mean)}</span>
              <span className="text-muted-foreground">
                n = {bar.count}
                {bar.errors ? `, ${t("{count} errors", { count: bar.errors })}` : ""}
              </span>
            </div>
          ))}
        </div>
        {apart.length ? (
          <div className="flex flex-col gap-0.5">
            <div className="text-xs text-wait">{t("Not on this chart, because they were not measured the same way:")}</div>
            {apart.map((bar) => (
              <div key={bar.key} className="text-xs text-muted-foreground">
                {bar.label} v{bar.version}: {scoreText(bar.mean)}. {bar.comparison ? comparisonText(bar.comparison) : ""}
              </div>
            ))}
          </div>
        ) : null}
      </figure>
    </>
  );
}
