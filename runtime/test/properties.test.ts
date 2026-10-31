import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { cutAtStop } from "../src/domain/fim.js";
import { commandSegments, resolvePermission, type PermissionLayer, type PermissionRule } from "../src/domain/permissions.js";
import { alternating, openAICompatibleUrl } from "../src/infrastructure/llm/lmstudio.js";
import type { ChatMessage } from "../src/infrastructure/llm/types.js";

// Property-based tests: fast-check generates many inputs per property and shrinks a failure to its smallest case.

const word = fc.stringMatching(/^[a-z][a-z0-9_-]{0,11}$/);
const argument = fc.stringMatching(/^[A-Za-z0-9_./=-]{1,16}$/);
const command = fc.tuple(word, fc.array(argument, { maxLength: 4 })).map(([program, args]) => [program, ...args].join(" "));
const separator = fc.constantFrom(" && ", " || ", "; ", " | ");
const shellLine = fc.array(command, { minLength: 1, maxLength: 4 }).chain((parts) =>
  fc.array(separator, { minLength: parts.length - 1, maxLength: parts.length - 1 }).map((seps) => parts.map((part, i) => (i ? seps[i - 1] : "") + part).join("")),
);
const effect = fc.constantFrom("allow" as const, "ask" as const, "deny" as const);
const codeRule = fc.record({ tool: fc.constant("code"), pattern: fc.oneof(fc.constant("*"), word.map((w) => `${w} *`)), effect });
const layers = fc.array(fc.record({ scope: fc.constantFrom("user" as const, "project" as const, "agent" as const), rules: fc.array(codeRule, { maxLength: 5 }) }), { maxLength: 3 });

test("a deny rule for every command beats any other rules, whatever the shell line", () => {
  fc.assert(fc.property(layers, shellLine, (extra, line) => {
    const deny: PermissionLayer = { scope: "user", rules: [{ tool: "code", pattern: "*", effect: "deny" }] };
    assert.equal(resolvePermission([...extra, deny], "code", { command: line })?.effect, "deny");
  }));
});

test("a shell line is allowed only when an allow rule covers every one of its commands", () => {
  fc.assert(fc.property(layers, shellLine, (given, line) => {
    const decision = resolvePermission(given, "code", { command: line });
    if (decision?.effect !== "allow") return;
    const rules = given.flatMap((layer) => layer.rules) as PermissionRule[];
    for (const segment of commandSegments(line)) {
      const program = segment.trim().split(/\s+/)[0];
      assert.ok(rules.some((rule) => rule.effect === "allow" && (rule.pattern === "*" || rule.pattern === `${program} *`)), `${segment} was allowed by no rule`);
    }
  }));
});

test("an allow rule for one program never allows a line that chains another", () => {
  fc.assert(fc.property(word, word, fc.array(argument, { maxLength: 3 }), separator, (allowed, other, args, sep) => {
    fc.pre(allowed !== other);
    const rules: PermissionLayer[] = [{ scope: "project", rules: [{ tool: "code", pattern: `${allowed} *`, effect: "allow" }] }];
    const line = `${[allowed, ...args].join(" ")}${sep}${other} --anything`;
    assert.notEqual(resolvePermission(rules, "code", { command: line })?.effect, "allow");
  }));
});

test("cutting at stop sequences keeps a prefix of the text with no stop sequence left in it", () => {
  fc.assert(fc.property(fc.string(), fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 5 }), (text, stops) => {
    const cut = cutAtStop(text, stops);
    assert.ok(text.startsWith(cut));
    for (const stop of stops) assert.ok(!cut.includes(stop));
    if (stops.every((stop) => !text.includes(stop))) assert.equal(cut, text);
  }));
});

const message = fc.record({
  role: fc.constantFrom("system" as const, "user" as const, "assistant" as const),
  content: fc.oneof(fc.constant(""), fc.string({ maxLength: 20 })),
});

test("LM Studio's turns always alternate, start with the user, and keep every non-empty turn's text", () => {
  fc.assert(fc.property(fc.array(message, { maxLength: 12 }), (messages) => {
    const out = alternating(messages as ChatMessage[]);
    const turns = out.filter((item) => item.role !== "system");
    if (turns.length) assert.equal(turns[0]?.role, "user");
    for (let i = 1; i < out.length; i += 1) {
      if (out[i]!.role !== "system") assert.notEqual(out[i]!.role, out[i - 1]!.role);
    }
    const all = out.map((item) => item.content).join("\n");
    for (const item of messages) if (item.content.trim()) assert.ok(all.includes(item.content.trim()));
  }));
});

test("LM Studio's OpenAI-compatible address always ends in /v1, and asking again changes nothing", () => {
  const host = fc.tuple(fc.constantFrom("http", "https", "ws", "wss"), fc.domain(), fc.integer({ min: 1, max: 65535 }), fc.constantFrom("", "/", "/v1", "/v1/", "/lmstudio"));
  fc.assert(fc.property(host, ([scheme, domain, port, path]) => {
    const url = openAICompatibleUrl(`${scheme}://${domain}:${port}${path}`);
    assert.match(url, /^https?:\/\/.+\/v1$/);
    assert.equal(openAICompatibleUrl(url), url);
  }));
});
