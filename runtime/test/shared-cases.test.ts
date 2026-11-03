import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { priceCall } from "../src/domain/llm/pricing.js";
import { commandSegments, fromClaudeRule, matchesRule, resolvePermission, suggestedPattern, type PermissionEffect, type PermissionLayer, type PermissionRule } from "../src/domain/permissions.js";
import { autonomyOf, isReadOnlyCall, isSensitiveOperation } from "../src/domain/policies.js";
import { account, dpapiScript } from "../src/infrastructure/secret-key.js";
import { decrypt, encrypt } from "../src/infrastructure/secrets-file.js";
import { FileStore } from "../src/infrastructure/store.js";
import { runCase, type LlmCase } from "./llm-cases.js";

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

test("the secrets file crates/saturn-store encrypts byte for byte, and its names for keys", async () => {
  const cases = JSON.parse(await readFile(new URL("../../contract/cases/secrets.json", import.meta.url), "utf8"));
  const key = Buffer.from(cases.key, "hex");
  assert.deepEqual(Object.fromEntries(decrypt(cases.envelope, key)), cases.secrets);
  const again = encrypt(new Map(Object.entries<string>(cases.secrets)), key, "file");
  assert.deepEqual(Object.fromEntries(decrypt(again, key)), cases.secrets);
  for (const item of cases.accounts) assert.equal(account(item.dir), item.account);
  assert.equal(dpapiScript("Protect"), cases.dpapi.Protect);
  assert.equal(dpapiScript("Unprotect"), cases.dpapi.Unprotect);
});

test("the state file crates/saturn-store also makes of the same saved file", async () => {
  const cases = JSON.parse(await readFile(new URL("../../contract/cases/state.json", import.meta.url), "utf8"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "saturn-shared-state-"));
  await writeFile(path.join(dir, "state.json"), JSON.stringify(cases.saved));
  const store = new FileStore(dir);
  await store.load();
  await store.update(() => undefined);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")), cases.written);
});

test("the prices crates/saturn-domain also gives", async () => {
  const cases = JSON.parse(await readFile(new URL("../../contract/cases/pricing.json", import.meta.url), "utf8"));
  assert.ok(cases.length > 300);
  for (const { expect, at, ...call } of cases) assert.deepEqual(priceCall({ ...call, at: new Date(at) }), expect, JSON.stringify(call));
});

test("what crates/saturn-llm also sends each provider, and makes of its replies", async () => {
  const cases = JSON.parse(await readFile(new URL("../../contract/cases/llm.json", import.meta.url), "utf8")) as (LlmCase & { sent: unknown; completion?: unknown; error?: unknown })[];
  assert.ok(cases.length >= 19);
  for (const item of cases) {
    const result = await runCase(item);
    assert.deepEqual(result.sent, item.sent, item.name);
    assert.deepEqual(result.completion, item.completion, item.name);
    assert.deepEqual(result.error, item.error, item.name);
  }
});
