import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TelemetryDocument } from "../src/infrastructure/telemetry-file.js";
import { render } from "../src/infrastructure/telemetry-formats.js";
import { WINDOWS_HELPER_SCRIPT, WINDOWS_HELPER_SOURCE } from "../src/infrastructure/skills/windows-helper.js";
import { priceCall } from "../src/domain/llm/pricing.js";
import { commandSegments, fromClaudeRule, matchesRule, resolvePermission, suggestedPattern, type PermissionEffect, type PermissionLayer, type PermissionRule } from "../src/domain/permissions.js";
import { autonomyOf, isReadOnlyCall, isSensitiveOperation } from "../src/domain/policies.js";
import { PatchDocument } from "../src/domain/skills/patch.js";
import { TaskPlan } from "../src/domain/skills/plan.js";
import { isPrivateHost, PublicAddress } from "../src/domain/skills/public-address.js";
import { Workspace } from "../src/domain/skills/workspace.js";
import { sandboxHint, sandboxMode, seatbeltProfile, type SandboxMode } from "../src/infrastructure/sandbox.js";
import { commandEnv, shellInvocation } from "../src/infrastructure/shell.js";
import { clip, integer, text } from "../src/infrastructure/skills/text.js";
import { pageText } from "../src/infrastructure/skills/web-skill.js";
import { account, dpapiScript } from "../src/infrastructure/secret-key.js";
import { decrypt, encrypt } from "../src/infrastructure/secrets-file.js";
import { FileStore } from "../src/infrastructure/store.js";
import { chunkFile } from "../src/domain/chunks.js";
import { answerCoreCase } from "./core-cases.js";
import { runCase, type LlmCase } from "./llm-cases.js";
import { generalSkills, cursorComputerUseSkills, cursorOriginSkills, antigravitySkills } from "../src/domain/builtin.js";
import { browserSkills } from "../src/domain/browser-tools.js";
import { LLM_PROVIDERS } from "../src/domain/llm/catalog.js";
import { INSTALL_RECIPES } from "../src/domain/marketplace.js";

type Case = { check: string; tool: string; arguments: Record<string, unknown>; expect: unknown; [key: string]: unknown };

test("the chunking crates/saturn-domain answers too, so both index a file alike", async () => {
  const cases = JSON.parse(await readFile(new URL("../../contract/cases/chunks.json", import.meta.url), "utf8")) as { file: string; content?: string; repeat?: number; chunks: unknown[] }[];
  assert.ok(cases.length > 20);
  for (const item of cases) {
    const content = item.content ?? Array.from({ length: item.repeat! }, () => "x").join("\n");
    assert.deepEqual(chunkFile(item.file, content), item.chunks, item.file);
  }
});

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

test("the cases crates/saturn-tools and saturn-domain answer too, so the tools behave alike", async () => {
  // Each check's fields are its own, so a case is read loosely here.
  const cases = JSON.parse(await readFile(new URL("../../contract/cases/tools.json", import.meta.url), "utf8")) as ({ check: string } & Record<string, any>)[];
  assert.ok(cases.length > 200);
  const attempt = (run: () => unknown) => {
    try {
      return { ok: run() };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };
  for (const item of cases) {
    const label = JSON.stringify(item);
    switch (item.check) {
      case "isPrivateHost":
        assert.equal(isPrivateHost(item.host), item.expect, label);
        break;
      case "publicAddress":
        assert.deepEqual(attempt(() => PublicAddress.parse(item.url).url.toString()), item.expect, label);
        break;
      case "patch":
        assert.deepEqual(attempt(() => {
          const document = PatchDocument.parse(item.patch);
          const update = document.changes.find((change) => change.kind === "update");
          const applied = item.source !== undefined && update?.kind === "update" ? attempt(() => document.apply(item.source, update.hunks)) : null;
          return { changes: JSON.parse(JSON.stringify(document.changes)), applied };
        }), item.expect, label);
        break;
      case "plan":
        assert.deepEqual(attempt(() => {
          const plan = TaskPlan.fromArgs(item.arguments);
          return { explanation: plan.explanation, steps: plan.steps };
        }), item.expect, label);
        break;
      case "value":
        assert.equal(text(item.value), item.text, label);
        assert.equal(integer(item.value, -99), item.integer, label);
        break;
      case "pageText":
        assert.deepEqual(pageText(item.html), item.expect, label);
        break;
      case "clip": {
        const whole = (item.text as string).repeat(item.times);
        const clipped = clip(whole);
        assert.equal(clipped.slice(0, 32_000), whole.slice(0, 32_000), label);
        assert.equal(clipped.slice(32_000), item.rest, label);
        break;
      }
      case "workspace": {
        if (process.platform === "win32") break;
        const workspace = new Workspace(item.root);
        assert.deepEqual(attempt(() => {
          const target = workspace.resolve(item.requested);
          return { target, relative: workspace.relative(target) };
        }), item.expect, label);
        break;
      }
      case "seatbelt":
        assert.equal(seatbeltProfile(item.mode as Exclude<SandboxMode, "off">, item.writable, item.network), item.expect, label);
        break;
      case "sandboxHint":
        assert.equal(sandboxHint(item.stderr, { mode: item.mode, network: item.network }) ?? null, item.expect, label);
        break;
      case "shell":
        assert.deepEqual(shellInvocation(item.command, item.posix, item.platform, item.env), item.expect, label);
        break;
      case "commandEnv":
        assert.deepEqual(commandEnv(item.platform, item.env), item.expect, label);
        break;
      case "sandboxMode":
        assert.equal(sandboxMode(item.value) ?? null, item.expect, label);
        break;
      default:
        assert.fail(`unknown check ${item.check}`);
    }
  }
});

test("the agent loop's cases crates/saturn-domain and crates/saturn-core answer too", async () => {
  const cases = JSON.parse(await readFile(new URL("../../contract/cases/core.json", import.meta.url), "utf8")) as (Record<string, unknown> & { expect: unknown })[];
  assert.ok(cases.length > 90);
  for (const item of cases) assert.deepEqual(answerCoreCase(item), item.expect, JSON.stringify(item).slice(0, 300));
});

test("crates/saturn-core keeps the same built-in tools", async () => {
  const servers = JSON.parse(await readFile(new URL("../../crates/saturn-core/src/builtin-servers.json", import.meta.url), "utf8")) as unknown;
  assert.deepEqual(servers, JSON.parse(JSON.stringify([generalSkills(), cursorComputerUseSkills(), cursorOriginSkills(), antigravitySkills(), browserSkills()])));
});

test("crates/saturn-core keeps the same list of providers and models", async () => {
  const providers = JSON.parse(await readFile(new URL("../../crates/saturn-core/src/llm-providers.json", import.meta.url), "utf8")) as unknown;
  assert.deepEqual(providers, LLM_PROVIDERS);
});

test("crates/saturn-core keeps the same integrations", async () => {
  const recipes = JSON.parse(await readFile(new URL("../../crates/saturn-core/src/install-recipes.json", import.meta.url), "utf8")) as unknown;
  assert.deepEqual(recipes, INSTALL_RECIPES);
});

test("the Windows desktop helper in Rust is the one written here", async () => {
  const folder = "../../crates/saturn-computer/src/windows/";
  assert.equal(await readFile(new URL(`${folder}helper.ps1`, import.meta.url), "utf8"), WINDOWS_HELPER_SCRIPT);
  assert.equal(await readFile(new URL(`${folder}helper.cs`, import.meta.url), "utf8"), WINDOWS_HELPER_SOURCE);
});

test("the export formats are the ones the Rust runtime is checked against", async () => {
  const cases = JSON.parse(await readFile(new URL("../../contract/cases/telemetry-formats.json", import.meta.url), "utf8")) as { document: TelemetryDocument; otlp: string; siem: string; emptyOtlp: string; emptySiem: string };
  assert.equal(render(cases.document, "otlp"), cases.otlp);
  assert.equal(render(cases.document, "siem"), cases.siem);
  assert.equal(render({ ...cases.document, traces: [], logs: [], metrics: [] }, "otlp"), cases.emptyOtlp);
});
