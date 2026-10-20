import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import type { AgentUsage, ModelUsage, UsageSummary, UsageTally } from "../domain/model";

type Period = "today" | "week" | "month" | "30d" | "all" | "custom";
const PERIODS: [Period, string][] = [
  ["today", "Today"],
  ["week", "This week"],
  ["month", "This month"],
  ["30d", "Last 30 days"],
  ["all", "All time"],
  ["custom", "Custom"],
];
const PERIOD_KEY = "saturn.usage.period";

function startOfDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

function addDays(day: Date, days: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

/** yyyy-mm-dd in local time, for date inputs. */
function dayValue(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

/** The window for a period, in local days: weeks start on Monday, and a custom end day is included. */
function rangeFor(period: Period, custom: { from: string; to: string }, now = new Date()): { from?: string; to?: string } {
  const today = startOfDay(now);
  if (period === "today") return { from: today.toISOString() };
  if (period === "week") return { from: addDays(today, -((today.getDay() + 6) % 7)).toISOString() };
  if (period === "month") return { from: new Date(today.getFullYear(), today.getMonth(), 1).toISOString() };
  if (period === "30d") return { from: addDays(today, -29).toISOString() };
  if (period === "custom") {
    const from = parseDay(custom.from);
    const to = parseDay(custom.to);
    return { ...(from ? { from: from.toISOString() } : {}), ...(to ? { to: addDays(to, 1).toISOString() } : {}) };
  }
  return {};
}

function savedPeriod(): Period {
  try {
    const value = window.localStorage.getItem(PERIOD_KEY);
    return PERIODS.some(([id]) => id === value) ? (value as Period) : "month";
  } catch {
    return "month";
  }
}


/** Small amounts keep four decimals so a few cents of testing still shows up. */
function usd(value: number): string {
  if (value === 0) return "$0.00";
  return `$${value < 1 ? value.toFixed(4) : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tokens(value: number): string {
  return value.toLocaleString();
}

function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
}

function total(tally: UsageTally): number {
  return tally.inputTokens + tally.outputTokens;
}

/** The cost cell: a figure, a figure with unpriced calls noted, or a dash when nothing had a price. */
function Cost(props: { tally: UsageTally }) {
  const { tally } = props;
  if (tally.unpricedCalls === tally.calls) {
    return (
      <span className="usage-cost muted" title="No official price for this model, so it is not included in the bill">
        —
      </span>
    );
  }
  return (
    <span className="usage-cost">
      <strong>{usd(tally.costUsd)}</strong>
      {tally.unpricedCalls ? <small>+{tally.unpricedCalls} unpriced</small> : null}
    </span>
  );
}

/** Usage & Billing for a chosen period; it reloads when the period changes or any of `refreshOn` does. */
export function UsageBilling(props: { refreshOn?: readonly unknown[] }) {
  const [period, setPeriod] = useState<Period>(savedPeriod);
  const [custom, setCustom] = useState(() => {
    const today = startOfDay(new Date());
    return { from: dayValue(addDays(today, -6)), to: dayValue(today) };
  });
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");

  function choose(next: Period) {
    setPeriod(next);
    try {
      window.localStorage.setItem(PERIOD_KEY, next);
    } catch {
      // Remembering the period is a convenience only.
    }
  }

  const range = rangeFor(period, custom);
  const rangeKey = `${range.from ?? ""}|${range.to ?? ""}`;
  useEffect(() => {
    let current = true;
    setError("");
    desktop.admin.usageSummary(range).then(
      (next) => current && setSummary(next),
      (reason: unknown) => current && setError(reason instanceof Error ? reason.message : "Could not load usage"),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, ...(props.refreshOn ?? [])]);

  const label = PERIODS.find(([id]) => id === period)?.[1] ?? "";
  const filter = (
    <div className="usage-filter">
      <div className="usage-periods" role="group" aria-label="Period">
        {PERIODS.map(([id, text]) => (
          <button key={id} type="button" className={period === id ? "active" : ""} aria-pressed={period === id} onClick={() => choose(id)}>
            {text}
          </button>
        ))}
      </div>
      {period === "custom" ? (
        <div className="usage-custom">
          <input type="date" className="input tiny" aria-label="From" value={custom.from} max={custom.to || undefined} onChange={(event) => setCustom({ ...custom, from: event.target.value })} />
          <span className="hint">to</span>
          <input type="date" className="input tiny" aria-label="To" value={custom.to} min={custom.from || undefined} onChange={(event) => setCustom({ ...custom, to: event.target.value })} />
        </div>
      ) : null}
    </div>
  );

  if (!summary) {
    return (
      <div className="usage">
        {filter}
        {error ? <p className="settings-row-error">{error}</p> : <p className="hint">Loading usage…</p>}
      </div>
    );
  }
  const { totals } = summary;
  const since = summary.since ? new Date(summary.since).toLocaleDateString() : null;
  const window_ = period === "all" ? (since ? `since ${since}` : "") : period === "custom" ? `${custom.from || "…"} – ${custom.to || "…"}` : label.toLowerCase();

  return (
    <div className="usage">
      {filter}
      {error ? <p className="settings-row-error">{error}</p> : null}
      <div className="usage-hero">
        <section className="card usage-stat">
          <span className="label">Total tokens</span>
          <strong>{tokens(total(totals))}</strong>
          <small>
            {tokens(totals.inputTokens)} input · {tokens(totals.outputTokens)} output · {totals.calls} {totals.calls === 1 ? "call" : "calls"}
          </small>
        </section>
        <section className="card usage-stat">
          <span className="label">Total bill</span>
          <strong>{usd(totals.costUsd)}</strong>
          <small>
            USD at each model's official price{window_ ? ` · ${window_}` : ""}
            {totals.unpricedCalls ? ` · ${totals.unpricedCalls} calls on unpriced models not included` : ""}
          </small>
        </section>
      </div>

      <section className="card usage-section">
        <div className="usage-section-head">
          <strong>By model</strong>
          <span className="hint">Priced at the rate in force when each call was made</span>
        </div>
        {summary.models.length === 0 ? (
          <p className="empty-box">{period === "all" ? "No model calls recorded yet." : "No model calls in this period."}</p>
        ) : (
          <div className="usage-table">
            <div className="usage-row head">
              <span>Model</span>
              <span>Calls</span>
              <span>Input</span>
              <span>Output</span>
              <span>Tokens</span>
              <span>Cost</span>
            </div>
            {summary.models.map((model) => <ModelRow key={`${model.provider}/${model.model}`} model={model} totals={totals} />)}
          </div>
        )}
      </section>

      <section className="card usage-section">
        <div className="usage-section-head">
          <strong>By agent</strong>
          <span className="hint">Each call counts toward the model the agent was using at that moment</span>
        </div>
        {summary.agents.length === 0 ? (
          <p className="empty-box">{period === "all" ? "No agent has used a model yet." : "No agent used a model in this period."}</p>
        ) : (
          <div className="usage-table">
            <div className="usage-row agent head">
              <span>Agent</span>
              <span>Calls</span>
              <span>Tokens</span>
              <span>Cost</span>
            </div>
            {summary.agents.map((agent) => <AgentRow key={agent.agentId} agent={agent} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function ModelRow(props: { model: ModelUsage; totals: UsageTally }) {
  const { model, totals } = props;
  const share = totals.costUsd > 0 ? model.costUsd / totals.costUsd : total(totals) ? total(model) / total(totals) : 0;
  return (
    <div className="usage-row">
      <span className="usage-name">
        <strong>{model.label}</strong>
        <small>{model.provider} · <code>{model.model}</code></small>
        <small className={model.price ? "usage-price" : "usage-price none"}>{model.price ?? "No official price"}</small>
        <span className="usage-share" aria-hidden="true"><span style={{ width: `${Math.max(share * 100, 1)}%` }} /></span>
      </span>
      <span>{model.calls}</span>
      <span>{tokens(model.inputTokens)}</span>
      <span>{tokens(model.outputTokens)}</span>
      <span><strong>{tokens(total(model))}</strong></span>
      <Cost tally={model} />
    </div>
  );
}

function AgentRow(props: { agent: AgentUsage }) {
  const { agent } = props;
  return (
    <div className="usage-row agent">
      <span className="usage-name">
        <strong>
          {agent.name}
          {agent.exists ? null : <em className="usage-tag">deleted</em>}
        </strong>
        <span className="usage-chips">
          {agent.models.map((model) => (
            <span key={`${model.provider}/${model.model}`} className="usage-chip" title={`${model.provider} · ${model.model}`}>
              {model.label}
              <em>{compact(total(model))} tokens</em>
              <em>{model.unpricedCalls === model.calls ? "unpriced" : usd(model.costUsd)}</em>
            </span>
          ))}
        </span>
      </span>
      <span>{agent.calls}</span>
      <span><strong>{tokens(total(agent))}</strong></span>
      <Cost tally={agent} />
    </div>
  );
}
