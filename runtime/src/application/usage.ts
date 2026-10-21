import { llmProvider } from "../domain/llm/catalog.js";
import { describePrice, priceCall } from "../domain/llm/pricing.js";
import { HttpError } from "../domain/errors.js";
import type { UsageRecord } from "../domain/model.js";
import type { RuntimeKernel } from "./kernel.js";

/** inputTokens counts every prompt token; cachedInputTokens and cacheWriteTokens are the parts billed at cache rates. */
type Tally = { calls: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; costUsd: number; unpricedCalls: number };

export type ModelUsage = Tally & {
  provider: string;
  model: string;
  label: string;
  /** Today's official price, described; null when the model has none. */
  price: string | null;
};

export type AgentUsage = Tally & {
  agentId: string;
  name: string;
  /** False once the agent has been deleted; its usage still counts. */
  exists: boolean;
  /** The models this agent actually ran on, as recorded per call. */
  models: (Tally & { provider: string; model: string; label: string })[];
};

/** A time window: calls made at or after `from` and before `to` (ISO times); either end may be open. */
export type UsageRange = { from?: string; to?: string };

export type UsageSummary = {
  currency: "USD";
  /** The window these totals cover, as asked for (null ends are open). */
  range: { from: string | null; to: string | null };
  since: string | null;
  totals: Tally;
  models: ModelUsage[];
  agents: AgentUsage[];
};

const empty = (): Tally => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpricedCalls: 0 });

function add(tally: Tally, record: UsageRecord, cost: number | null): void {
  tally.calls += 1;
  tally.inputTokens += record.inputTokens;
  tally.outputTokens += record.outputTokens;
  tally.cachedInputTokens += record.cachedInputTokens ?? 0;
  tally.cacheWriteTokens += record.cacheWriteTokens ?? 0;
  if (cost === null) tally.unpricedCalls += 1;
  else tally.costUsd += cost;
}

function bySpend<T extends Tally>(a: T, b: T): number {
  return b.costUsd - a.costUsd || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
}

/** Token and cost totals from the per-call usage history. */
export class UsageService {
  constructor(private readonly kernel: RuntimeKernel) {}

  records(): UsageRecord[] {
    return this.kernel.store.state.usage;
  }

  /**
   * A record's cost as fixed when it was made. Records from before costs were recorded are priced
   * now from the same official table, at the time they were made.
   */
  private cost(record: UsageRecord): number | null {
    if (record.costUsd !== undefined) return record.costUsd;
    const connection = this.kernel.store.state.models.find((item) => item.id === record.modelId);
    const hosted = connection ? this.kernel.llm.hosted(connection) : Boolean(llmProvider(record.provider));
    return priceCall({
      provider: record.provider,
      model: record.model,
      hosted,
      at: new Date(record.createdAt),
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedTokens: record.cachedInputTokens,
      cacheWriteTokens: record.cacheWriteTokens,
    })?.costUsd ?? null;
  }

  private label(record: UsageRecord): string {
    const known = llmProvider(record.provider)?.models.find((item) => item.id === record.model)?.label;
    return known ?? record.modelName ?? record.model;
  }

  summary(range: UsageRange = {}): UsageSummary {
    const from = instant(range.from, "from");
    const to = instant(range.to, "to");
    if (from !== null && to !== null && from >= to) throw new HttpError(400, "The range must end after it starts");
    const records = this.records().filter((record) => {
      const at = Date.parse(record.createdAt);
      return (from === null || at >= from) && (to === null || at < to);
    });
    const agentsNow = new Map(this.kernel.store.state.agents.map((agent) => [agent.id, agent.name]));
    const totals = empty();
    const models = new Map<string, ModelUsage>();
    const agents = new Map<string, AgentUsage & { byModel: Map<string, AgentUsage["models"][number]> }>();

    for (const record of records) {
      const cost = this.cost(record);
      const key = `${record.provider}/${record.model}`;
      const label = this.label(record);
      add(totals, record, cost);

      let model = models.get(key);
      if (!model) {
        model = { ...empty(), provider: record.provider, model: record.model, label, price: describePrice(record.provider, record.model) };
        models.set(key, model);
      }
      add(model, record, cost);

      let agent = agents.get(record.agentId);
      if (!agent) {
        const current = agentsNow.get(record.agentId);
        agent = {
          ...empty(),
          agentId: record.agentId,
          name: current ?? record.agentName ?? "Deleted agent",
          exists: current !== undefined,
          models: [],
          byModel: new Map(),
        };
        agents.set(record.agentId, agent);
      }
      add(agent, record, cost);
      let used = agent.byModel.get(key);
      if (!used) {
        used = { ...empty(), provider: record.provider, model: record.model, label };
        agent.byModel.set(key, used);
      }
      add(used, record, cost);
    }

    return {
      currency: "USD",
      range: { from: from === null ? null : new Date(from).toISOString(), to: to === null ? null : new Date(to).toISOString() },
      since: records.length ? records.reduce((oldest, item) => (item.createdAt < oldest ? item.createdAt : oldest), records[0].createdAt) : null,
      totals,
      models: [...models.values()].sort(bySpend),
      agents: [...agents.values()]
        .map(({ byModel, ...agent }) => ({ ...agent, models: [...byModel.values()].sort(bySpend) }))
        .sort(bySpend),
    };
  }
}

/** A range end as epoch milliseconds; empty is open, anything unparseable is the caller's mistake. */
function instant(value: string | undefined, name: string): number | null {
  if (value === undefined || value === "") return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new HttpError(400, `${name} must be a date or time`);
  return at;
}
