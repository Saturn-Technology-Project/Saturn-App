import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { comparisonText, scoreText, type Comparison, type ExperimentRun, type FrozenVersion, type ModelNode, type RunSummary } from "../../domain/research.js";
import { messageOf } from "../ui/Parts.js";

const service = desktop.research;

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
 * Each model's mean score, in the order the runs happened. Only what measured the same way shares the axis: anything else
 * is listed under it with what differs, so a difference in method never reads as a difference in the model.
 */
export function ScoreChart(props: { projectId: string; runs: ExperimentRun[]; versions: FrozenVersion[]; models: ModelNode[]; notify: (message: string) => void }) {
  const { projectId, runs, versions, models, notify } = props;
  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [comparisons, setComparisons] = useState<Record<string, Comparison>>({});
  const [scorer, setScorer] = useState<string | null>(null);
  const runKey = runs.map((run) => `${run.id}:${run.status}`).join(",");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const loaded = await Promise.all(runs.map((run) => service.summary(projectId, run.id)));
        const first = loaded[0]?.versionId;
        const distinct = [...new Set(loaded.map((item) => item.versionId))];
        const compared = await Promise.all(distinct.map(async (version) => [version, await service.compare(projectId, first, version)] as const));
        if (live) {
          setSummaries(loaded);
          setComparisons(Object.fromEntries(compared));
        }
      } catch (error) {
        if (live) notify(messageOf(error));
      }
    })();
    return () => {
      live = false;
    };
    // `runKey` says when the runs changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify, projectId, runKey]);

  const scorers = [...new Set(summaries.flatMap((summary) => summary.models.flatMap((model) => Object.keys(model.scores))))];
  const chosen = scorer && scorers.includes(scorer) ? scorer : scorers[0];
  if (!chosen) return null;

  const bars: Bar[] = summaries.flatMap((summary) =>
    summary.models.map((model) => {
      const node = models.find((item) => item.id === model.modelId);
      return {
        key: `${summary.runId}:${model.modelId ?? ""}`,
        label: node?.name ?? node?.source ?? model.modelId ?? "This run",
        version: versions.find((version) => version.id === summary.versionId)?.number ?? 0,
        mean: model.scores[chosen]?.mean ?? null,
        count: model.scores[chosen]?.count ?? 0,
        errors: Object.values(model.errors).reduce((sum, count) => sum + count, 0),
        comparison: comparisons[summary.versionId] ?? null,
      };
    }),
  );
  const shared = bars.filter((bar) => bar.comparison?.result === "comparable");
  const apart = bars.filter((bar) => bar.comparison?.result !== "comparable");
  const widest = Math.max(...shared.map((bar) => Math.abs(bar.mean ?? 0)), Number.EPSILON);

  return (
    <>
      <h2>Mean score</h2>
      <figure className="lab-chart">
        {scorers.length > 1 ? (
          <label className="lab-field" style={{ maxWidth: 220 }}>
            Scorer
            <select value={chosen} onChange={(event) => setScorer(event.target.value)}>
              {scorers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <figcaption className="lab-muted">{chosen}, measured the same way as the first run</figcaption>
        )}
        <div className="lab-chart-rows">
          {shared.map((bar) => (
            <div className="lab-chart-row" key={bar.key} title={`${bar.label}, v${bar.version}: ${scoreText(bar.mean)} from ${bar.count} samples`}>
              <span className="lab-chart-label">
                {bar.label} <span className="lab-muted">v{bar.version}</span>
              </span>
              <span className="lab-chart-track">
                <span className="lab-chart-bar" style={{ width: `${(Math.abs(bar.mean ?? 0) / widest) * 100}%` }} />
              </span>
              <span className="lab-chart-value">{scoreText(bar.mean)}</span>
              <span className="lab-muted">
                n = {bar.count}
                {bar.errors ? `, ${bar.errors} errors` : ""}
              </span>
            </div>
          ))}
        </div>
        {apart.length ? (
          <div className="lab-chart-apart">
            <div className="lab-warning">Not on this chart, because they were not measured the same way:</div>
            {apart.map((bar) => (
              <div key={bar.key} className="lab-muted">
                {bar.label} v{bar.version}: {scoreText(bar.mean)}. {bar.comparison ? comparisonText(bar.comparison) : ""}
              </div>
            ))}
          </div>
        ) : null}
      </figure>
    </>
  );
}
