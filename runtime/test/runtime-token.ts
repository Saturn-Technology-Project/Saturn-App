import { randomBytes } from "node:crypto";

/**
 * Test support for the runtime's auth: a fixed token the runtime will accept (via SATURN_RUNTIME_TOKEN),
 * plus a fetch wrapper that attaches it only to requests aimed at the runtime under test — mock LLM and MCP
 * servers (on other ports) are left untouched, so their own Authorization headers are unchanged.
 */
export const TEST_TOKEN = `test-${randomBytes(24).toString("hex")}`;
process.env.SATURN_RUNTIME_TOKEN = TEST_TOKEN;

let authBase = "";

/** Point the fetch wrapper at a runtime's base URL so its requests carry the test token. */
export function useRuntimeAuth(base: string): void {
  authBase = base;
}

/** The un-wrapped fetch, for tests that must call the runtime WITHOUT the token (to prove it is refused). */
export const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (authBase && url.startsWith(authBase)) {
    return realFetch(input, { ...init, headers: { authorization: `Bearer ${TEST_TOKEN}`, ...(init?.headers ?? {}) } });
  }
  return realFetch(input, init);
}) as typeof fetch;
