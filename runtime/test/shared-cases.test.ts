import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { commandSegments, fromClaudeRule, matchesRule, resolvePermission, suggestedPattern, type PermissionEffect, type PermissionLayer, type PermissionRule } from "../src/domain/permissions.js";
import { autonomyOf, isReadOnlyCall, isSensitiveOperation } from "../src/domain/policies.js";

type Case = { check: string; tool: string; arguments: Record<string, unknown>; expect: unknown; [key: string]: unknown };

test("the cases crates/saturn-domain answers too, so both implementations decide alike", async () => {
  const cases = JSON.parse(await readFile(new URL("../../contract/cases/permissions.json", import.meta.url), "utf8")) as Case[];
  assert.ok(cases.length > 80);
  for (const item of cases) {
    const label = JSON.stringify(item);
    switch (item.check) {
      case "commandSegments":
        assert.deepEqual(commandSegments(item.command as string), item.expect, label);
        break;
      case "matchesRule":
        assert.equal(matchesRule(item.rule as PermissionRule, item.tool, item.arguments), item.expect, label);
        break;
      case "resolvePermission": {
        const decision = resolvePermission(item.layers as PermissionLayer[], item.tool, item.arguments);
        assert.equal(decision?.effect ?? null, item.effect, label);
        assert.equal(decision?.scope ?? null, item.scope, label);
        break;
      }
      case "fromClaudeRule":
        assert.deepEqual(fromClaudeRule(item.text as string, item.effect as PermissionEffect) ?? null, item.expect, label);
        break;
      case "suggestedPattern":
        assert.equal(suggestedPattern(item.tool, item.arguments), item.expect, label);
        break;
      case "isSensitiveOperation":
        assert.equal(isSensitiveOperation(item.tool, item.arguments), item.expect, label);
        break;
      case "isReadOnlyCall":
        assert.equal(isReadOnlyCall(item.tool, item.arguments, (item.category as "read" | "write" | null) ?? undefined), item.expect, label);
        break;
      case "autonomyOf":
        assert.equal(autonomyOf(item.value), item.expect, label);
        break;
      default:
        assert.fail(`unknown check ${item.check}`);
    }
  }
});
