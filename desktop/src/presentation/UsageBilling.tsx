import type { AgentUsage, ModelUsage, UsageSummary, UsageTally } from "../domain/model";

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

export function UsageBilling(props: { summary: UsageSummary | null }) {
  const summary = props.summary;
  if (!summary) return <p className="hint">Loading usage…</p>;
  const { totals } = summary;
  const since = summary.since ? new Date(summary.since).toLocaleDateString() : null;

  return (
    <div className="usage">
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
            USD at each model's official price{since ? ` · since ${since}` : ""}
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
          <p className="empty-box">No model calls recorded yet.</p>
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
          <p className="empty-box">No agent has used a model yet.</p>
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
