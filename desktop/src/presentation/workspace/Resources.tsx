import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { bytesText, durationText, isRunActive, throughput, type ExperimentRun, type ResourcePoint, type RunResources } from "../../domain/research.js";
import { messageOf } from "../ui/Parts.js";

const service = desktop.research;

/** What a run costs: processor, memory, GPUs and how fast its samples come, read again every two seconds while it lives. */
export function Resources(props: { projectId: string; run: ExperimentRun; notify: (message: string) => void }) {
  const { projectId, run, notify } = props;
  const [read, setRead] = useState<RunResources | null>(null);
  const active = isRunActive(run.status);

  useEffect(() => {
    let live = true;
    const load = () =>
      service
        .resources(projectId, run.id)
        .then((latest) => {
          if (live) setRead(latest);
        })
        .catch((error: unknown) => {
          if (live) notify(messageOf(error));
        });
    void load();
    const timer = active ? window.setInterval(() => void load(), 2000) : null;
    return () => {
      live = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [active, notify, projectId, run.id]);

  const points = read?.points ?? [];
  const last = points.at(-1);
  if (!read) return <p className="lab-muted">Reading…</p>;
  if (!last) return <p className="lab-muted">{active ? "The first reading comes within two seconds." : "Nothing was sampled for this run."}</p>;
  const rate = throughput(points);
  const tokenRate = throughput(points, 10, (point) => point.outputTokens);
  const peakMemory = Math.max(...points.map((point) => point.memoryBytes ?? 0));
  const peakDevice = Math.max(...points.map((point) => point.deviceMemoryBytes ?? 0));
  const gpu = last.gpus?.[0];

  return (
    <div className="lab-resources">
      {last.samplesRewrites ? <div className="lab-warning">samples.jsonl was rewritten {last.samplesRewrites} {last.samplesRewrites === 1 ? "time" : "times"}. Counts restarted from the current file. A run must append samples; earlier file contents may have been lost.</div> : null}
      <div className="lab-stats">
        <Stat label={active ? "Running for" : "Ran for"} value={durationText(last.elapsedMs)} />
        <Stat label="Processor" value={last.cpuPercent === null ? "—" : `${last.cpuPercent.toFixed(0)}%`} hint={`of ${read.system.cpus * 100}% on ${read.system.cpus} cores, ${last.processes ?? 0} processes`} />
        <Stat label="Memory" value={bytesText(last.memoryBytes)} hint={`peak ${bytesText(peakMemory)}`} />
        <Stat label="Samples" value={String(last.samplesLines)} hint={rate === null ? bytesText(last.samplesBytes) : `${rate.toFixed(rate < 1 ? 2 : 1)} per second, ${bytesText(last.samplesBytes)}`} />
        {last.inputTokens || last.outputTokens ? (
          <Stat label="Tokens" value={`${last.outputTokens.toLocaleString()} out`} hint={`${last.inputTokens.toLocaleString()} in${tokenRate === null ? "" : `, ${tokenRate.toFixed(tokenRate < 10 ? 1 : 0)} out per second`}, as the program reported`} />
        ) : null}
        {last.deviceMemoryBytes !== null ? <Stat label="Device memory" value={bytesText(last.deviceMemoryBytes)} hint={`peak ${bytesText(peakDevice)}, as the program reported`} /> : null}
        {gpu ? <Stat label={gpu.name} value={gpu.utilizationPercent === null ? "—" : `${gpu.utilizationPercent.toFixed(0)}%`} hint={`${bytesText(gpu.memoryUsedBytes)} of ${bytesText(gpu.memoryTotalBytes)}`} /> : <Stat label="GPU" value="None seen" hint={read.system.platform === "macos" ? "Apple GPUs are not reported by the system" : "nvidia-smi is not on this computer"} />}
      </div>
      <div className="lab-sparklines">
        <Sparkline label="Processor %" points={points} pick={(point) => point.cpuPercent} />
        <Sparkline label="Memory" points={points} pick={(point) => point.memoryBytes} format={bytesText} />
        <Sparkline label="Samples" points={points} pick={(point) => point.samplesLines} />
        {last.outputTokens ? <Sparkline label="Output tokens" points={points} pick={(point) => point.outputTokens} /> : null}
        {last.deviceMemoryBytes !== null ? <Sparkline label="Device memory" points={points} pick={(point) => point.deviceMemoryBytes} format={bytesText} /> : null}
        {gpu ? <Sparkline label="GPU %" points={points} pick={(point) => point.gpus?.[0]?.utilizationPercent ?? null} /> : null}
      </div>
      <div className="lab-muted">Sampled every two seconds from the run's own processes. Nothing here is derived; a number the system did not give is left out.</div>
    </div>
  );
}

function Stat(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="lab-stat">
      <span className="lab-muted">{props.label}</span>
      <strong>{props.value}</strong>
      {props.hint ? <span className="lab-muted">{props.hint}</span> : null}
    </div>
  );
}

/** One line over time, scaled to its own top value; the title carries the numbers. */
function Sparkline(props: { label: string; points: ResourcePoint[]; pick: (point: ResourcePoint) => number | null; format?: (value: number) => string }) {
  const { label, points, pick, format = (value: number) => value.toFixed(value < 10 ? 1 : 0) } = props;
  const values = points.map((point) => pick(point)).map((value) => (value === null ? 0 : value));
  const top = Math.max(...values, Number.EPSILON);
  const width = 240;
  const height = 48;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const line = values.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / top) * (height - 4) - 2).toFixed(1)}`).join(" ");
  const latest = values.at(-1) ?? 0;
  return (
    <figure className="lab-sparkline" title={`${label}: now ${format(latest)}, top ${format(top)}`}>
      <figcaption className="lab-muted">
        {label} <span className="lab-sparkline-value">{format(latest)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`${label} over time, now ${format(latest)}`}>
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </figure>
  );
}
