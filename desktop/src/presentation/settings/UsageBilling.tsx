import { useEffect, useState, type ReactNode } from "react";
import { desktop } from "../../application/desktop";
import type { AgentUsage, ModelUsage, UsageSummary, UsageTally } from "../../domain/model";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { classes } from "../ui/base/classes.js";
import { Input } from "../ui/base/Input.js";
import { RowError } from "./Parts";

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

/** How the figures are set: the page's own width, not the window's, decides how many columns fit. */
const USAGE = "@container flex flex-col gap-3";
const STAT = "text-[28px] font-semibold tracking-tight tabular-nums @max-[380px]:text-[22px]";
const SECTION_HEAD = "mb-2 flex flex-wrap items-baseline justify-between gap-3";
const EMPTY = "m-0 rounded-lg border border-dashed border-input p-3 text-center text-xs text-muted-foreground";
const NAME = "flex min-w-0 flex-col gap-0.5";
const NAME_TITLE = "flex items-center gap-1.5 text-[13px]";
const NAME_NOTE = "text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]";

/** One line of a usage table; the narrower the page, the fewer columns it keeps. */
function UsageRow(props: { agent?: boolean; head?: boolean; children: ReactNode }) {
  return (
    <div
      className={classes(
        "grid items-start gap-3 border-t border-border py-2.5 text-[12.5px] tabular-nums [&>span:not(:first-child)]:text-right",
        props.agent
          ? "grid-cols-[minmax(200px,1fr)_52px_96px_104px] @max-[640px]:grid-cols-[minmax(0,1fr)_90px_90px] @max-[640px]:[&>span:nth-child(2)]:hidden"
          : "grid-cols-[minmax(180px,1fr)_52px_88px_88px_96px_104px] @max-[640px]:grid-cols-[minmax(0,1fr)_80px_90px] @max-[640px]:[&>span:nth-child(-n+4):not(:first-child)]:hidden",
        props.head && "border-t-0 pt-0 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase",
      )}
    >
      {props.children}
    </div>
  );
}

/** The cost cell: a figure, a figure with unpriced calls noted, or a dash when nothing had a price. */
function Cost(props: { tally: UsageTally }) {
  const { tally } = props;
  if (tally.unpricedCalls === tally.calls) {
    return (
      <span className="flex flex-col items-end text-muted-foreground" title="No official price for this model, so it is not included in the bill">
        —
      </span>
    );
  }
  return (
    <span className="flex flex-col items-end">
      <strong>{usd(tally.costUsd)}</strong>
      {tally.unpricedCalls ? <small className="text-[11px] text-wait">+{tally.unpricedCalls} unpriced</small> : null}
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="inline-flex flex-wrap gap-0.5 rounded-lg border border-border p-0.5" role="group" aria-label="Period">
        {PERIODS.map(([id, text]) => (
          <Button key={id} type="button" variant={period === id ? "soft" : "ghost"} size="small" className={period === id ? undefined : "text-muted-foreground"} aria-pressed={period === id} onClick={() => choose(id)}>
            {text}
          </Button>
        ))}
      </div>
      {period === "custom" ? (
        <div className="inline-flex items-center gap-1.5">
          <Input type="date" className="w-auto [color-scheme:light_dark]" aria-label="From" value={custom.from} max={custom.to || undefined} onChange={(event) => setCustom({ ...custom, from: event.target.value })} />
          <span className="text-[12.5px] text-muted-foreground">to</span>
          <Input type="date" className="w-auto [color-scheme:light_dark]" aria-label="To" value={custom.to} min={custom.from || undefined} onChange={(event) => setCustom({ ...custom, to: event.target.value })} />
        </div>
      ) : null}
    </div>
  );

  if (!summary) {
    return (
      <div className={USAGE}>
        {filter}
        {error ? <RowError className="mt-0">{error}</RowError> : <p className="text-[12.5px] text-muted-foreground">Loading usage…</p>}
      </div>
    );
  }
  const { totals } = summary;
  const since = summary.since ? new Date(summary.since).toLocaleDateString() : null;
  const window_ = period === "all" ? (since ? `since ${since}` : "") : period === "custom" ? `${custom.from || "…"} – ${custom.to || "…"}` : label.toLowerCase();

  return (
    <div className={USAGE}>
      {filter}
      {error ? <RowError className="mt-0">{error}</RowError> : null}
      <div className="grid grid-cols-2 gap-3 @max-[380px]:grid-cols-1">
        <Card className="gap-1">
          <span className="text-xs font-medium text-muted-foreground">Total tokens</span>
          <strong className={STAT}>{tokens(total(totals))}</strong>
          <small className="text-xs text-muted-foreground">
            {tokens(totals.inputTokens)} input{totals.cachedInputTokens ? ` (${tokens(totals.cachedInputTokens)} from cache, ${Math.round((totals.cachedInputTokens / Math.max(1, totals.inputTokens)) * 100)}%)` : ""} · {tokens(totals.outputTokens)} output · {totals.calls} {totals.calls === 1 ? "call" : "calls"}
          </small>
        </Card>
        <Card className="gap-1">
          <span className="text-xs font-medium text-muted-foreground">Total bill</span>
          <strong className={STAT}>{usd(totals.costUsd)}</strong>
          <small className="text-xs text-muted-foreground">
            USD at each model's official price{window_ ? ` · ${window_}` : ""}
            {totals.unpricedCalls ? ` · ${totals.unpricedCalls} calls on unpriced models not included` : ""}
          </small>
        </Card>
      </div>

      <Card className="gap-0">
        <div className={SECTION_HEAD}>
          <strong className="text-sm">By model</strong>
          <span className="text-[12.5px] text-muted-foreground">Priced at the rate in force when each call was made</span>
        </div>
        {summary.models.length === 0 ? (
          <p className={EMPTY}>{period === "all" ? "No model calls recorded yet." : "No model calls in this period."}</p>
        ) : (
          <div className="flex flex-col">
            <UsageRow head>
              <span>Model</span>
              <span>Calls</span>
              <span>Input</span>
              <span>Output</span>
              <span>Tokens</span>
              <span>Cost</span>
            </UsageRow>
            {summary.models.map((model) => <ModelRow key={`${model.provider}/${model.model}`} model={model} totals={totals} />)}
          </div>
        )}
      </Card>

      <Card className="gap-0">
        <div className={SECTION_HEAD}>
          <strong className="text-sm">By agent</strong>
          <span className="text-[12.5px] text-muted-foreground">Each call counts toward the model the agent was using at that moment</span>
        </div>
        {summary.agents.length === 0 ? (
          <p className={EMPTY}>{period === "all" ? "No agent has used a model yet." : "No agent used a model in this period."}</p>
        ) : (
          <div className="flex flex-col">
            <UsageRow agent head>
              <span>Agent</span>
              <span>Calls</span>
              <span>Tokens</span>
              <span>Cost</span>
            </UsageRow>
            {summary.agents.map((agent) => <AgentRow key={agent.agentId} agent={agent} />)}
          </div>
        )}
      </Card>
    </div>
  );
}

function ModelRow(props: { model: ModelUsage; totals: UsageTally }) {
  const { model, totals } = props;
  const share = totals.costUsd > 0 ? model.costUsd / totals.costUsd : total(totals) ? total(model) / total(totals) : 0;
  return (
    <UsageRow>
      <span className={NAME}>
        <strong className={NAME_TITLE}>{model.label}</strong>
        <small className={NAME_NOTE}>{model.provider} · <code className="text-[11px]">{model.model}</code></small>
        <small className={classes(NAME_NOTE, model.price ? "text-muted-foreground" : "text-wait")}>{model.price ?? "No official price"}</small>
        <span className="mt-1 block h-[3px] overflow-hidden rounded-sm bg-muted" aria-hidden="true"><span className="block h-full bg-info" style={{ width: `${Math.max(share * 100, 1)}%` }} /></span>
      </span>
      <span>{model.calls}</span>
      <span title={model.cachedInputTokens ? `${tokens(model.cachedInputTokens)} of these from the cache, billed at its lower rate` : undefined}>{tokens(model.inputTokens)}{model.cachedInputTokens ? <small className="text-[11px] text-muted-foreground"> · {Math.round((model.cachedInputTokens / Math.max(1, model.inputTokens)) * 100)}% cached</small> : null}</span>
      <span>{tokens(model.outputTokens)}</span>
      <span><strong>{tokens(total(model))}</strong></span>
      <Cost tally={model} />
    </UsageRow>
  );
}

function AgentRow(props: { agent: AgentUsage }) {
  const { agent } = props;
  return (
    <UsageRow agent>
      <span className={NAME}>
        <strong className={NAME_TITLE}>
          {agent.name}
          {agent.exists ? null : <Badge className="h-auto px-1.5 text-[10.5px]">deleted</Badge>}
        </strong>
        <span className="mt-1 flex flex-wrap gap-1">
          {agent.models.map((model) => (
            <span key={`${model.provider}/${model.model}`} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-[11.5px]" title={`${model.provider} · ${model.model}`}>
              {model.label}
              <span className="text-muted-foreground tabular-nums">{compact(total(model))} tokens</span>
              <span className="text-muted-foreground tabular-nums">{model.unpricedCalls === model.calls ? "unpriced" : usd(model.costUsd)}</span>
            </span>
          ))}
        </span>
      </span>
      <span>{agent.calls}</span>
      <span><strong>{tokens(total(agent))}</strong></span>
      <Cost tally={agent} />
    </UsageRow>
  );
}
