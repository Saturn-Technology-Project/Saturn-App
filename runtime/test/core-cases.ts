import { budgetHistory, clipMiddle, compactActions, contextTokensFor, estimateTokens, historyBudgetChars, splitForCompaction } from "../src/domain/context.js";
import { unifiedDiff } from "../src/domain/diff.js";
import { buildSystemPrompt, clip, explainRunError, joinThinking, numberOf, readOnlyRefusal } from "../src/domain/policies.js";
import { loadNote, toolkitServer } from "../src/domain/toolkits.js";
import type { Agent, RunAction, ToolRound } from "../src/domain/model.js";
import { fromClaudeHooks, hooksFingerprint, matchesTool, parseAnswer, type Hook } from "../src/application/hooks.js";
import { merge, parseNotes } from "../src/application/memory.js";
import { allowsEverything, rulesFingerprint } from "../src/application/permissions.js";
import { toolTurns } from "../src/application/runs.js";
import { parseSkill, skillsPrompt, type SkillInfo } from "../src/application/skill-files.js";
import type { PermissionRule } from "../src/domain/permissions.js";

/** A value as JSON writes it, so `undefined` fields read as missing on both sides. */
const plain = (value: unknown): unknown => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const bytes = (text: unknown): Buffer | null => (typeof text === "string" ? Buffer.from(text) : null);

/** What the TypeScript implementation answers to one case of contract/cases/core.json. */
export function answerCoreCase(item: Record<string, any>): unknown {
  const model = { provider: item.provider, model: item.model, ...(item.contextTokens !== undefined ? { contextTokens: item.contextTokens } : {}) };
  switch (item.check) {
    case "estimateTokens": return estimateTokens(item.text);
    case "contextTokens": return contextTokensFor(model);
    case "historyBudget": return historyBudgetChars(model);
    case "clipMiddle": return clipMiddle(item.text, item.limit);
    case "compactActions": return plain(compactActions(item.actions as RunAction[]));
    case "budgetHistory": {
      const turns = (item.turns as [string, number][]).map(([role, size]) => ({ role, content: "x".repeat(size) }));
      return budgetHistory(turns, item.budget).omitted;
    }
    case "splitForCompaction": return splitForCompaction((item.sizes as number[]).map((chars) => ({ chars })), item.keep).old.length;
    case "clip": return clip(item.text, item.limit);
    case "explainRunError": return explainRunError(new Error(item.message));
    case "readOnlyRefusal": return readOnlyRefusal(item.mode);
    case "joinThinking": return joinThinking(item.current ?? undefined, item.next);
    case "numberOf": return numberOf(item.value, item.fallback, item.low, item.high);
    case "prompt": return buildSystemPrompt({ agent: { instructions: item.instructions, mcpConnectionIds: [] } as unknown as Agent, serverIds: item.serverIds, deferred: item.deferred, memory: item.memory, rules: item.rules, context: item.context, planApproval: item.planApproval, mode: item.mode });
    case "matchesTool": return matchesTool(item.matcher ?? undefined, item.tool);
    case "fromClaudeHooks": return plain(fromClaudeHooks(item.value));
    case "fingerprint": return hooksFingerprint(item.hooks as Hook[]);
    case "parseAnswer": return plain(parseAnswer(item.stdout));
    case "parseSkill": return parseSkill(item.text, item.fallback);
    case "skillsPrompt": return skillsPrompt((item.skills as [string, string][]).map(([name, description]) => ({ name, description }) as SkillInfo));
    case "diff": return unifiedDiff(item.file, bytes(item.before), bytes(item.after));
    case "toolkitServer": return toolkitServer(item.name) ?? null;
    case "loadNote": return loadNote(item.server);
    case "allowsEverything": return allowsEverything(item.rule as PermissionRule);
    case "rulesFingerprint": return rulesFingerprint(item.rules as PermissionRule[]);
    case "parseNotes": return parseNotes(item.text);
    case "mergeNotes": return merge(item.existing, item.entries);
    case "toolTurns": return plain(toolTurns(item.rounds as ToolRound[], item.actions as RunAction[]));
    default: throw new Error(`unknown check ${item.check}`);
  }
}
