// What every Saturn runtime must do over HTTP, whichever language it is written in: the desktop app and Saturn IDE
// depend on it. Run with SATURN_TEST_RUNTIME=ts or rust (see runtime.mjs).
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { startRuntime } from "./runtime.mjs";

let runtime;
let token;

before(async () => {
  runtime = await startRuntime();
  token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
});
after(() => runtime?.stop());

/** A raw request, because fetch does not let a caller choose the Host header. */
function request({ method = "GET", path: target, headers = {} }) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port: runtime.port, method, path: target, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("the health probe answers without the token", async () => {
  const response = await request({ path: "/health" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});

test("the session token is long and only this user can read its file", async () => {
  assert.ok(token.length >= 32);
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(runtime.dataDir, "runtime-token"))).mode & 0o777, 0o600);
  }
});

test("a request without the right token is refused", async () => {
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: token }]) {
    const response = await request({ path: "/agents", headers });
    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(response.body), { error: "Unauthorized" });
  }
});

test("the right token gets past the check", async () => {
  // A route the runtime has not brought over yet answers 404, so this asserts only what the check decides.
  const response = await request({ path: "/agents", headers: { authorization: `Bearer ${token}` } });
  assert.notEqual(response.status, 401);
  assert.notEqual(response.status, 403);
});

test("a Host that is not loopback is refused, even with the token and on open paths", async () => {
  for (const target of ["/health", "/agents"]) {
    const response = await request({ path: target, headers: { host: "rebind.example", authorization: `Bearer ${token}` } });
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), { error: "Forbidden" });
  }
  assert.equal((await request({ path: "/health", headers: { host: `localhost:${runtime.port}` } })).status, 200);
  // IPv6 loopback is refused too: the runtime listens on IPv4 unless told otherwise.
  assert.equal((await request({ path: "/health", headers: { host: `[::1]:${runtime.port}` } })).status, 403);
});

test("only loopback origins are allowed across origins", async () => {
  const preflight = (origin) => request({ method: "OPTIONS", path: "/agents", headers: { origin } });

  const allowed = await preflight("http://127.0.0.1:5174");
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["access-control-allow-origin"], "http://127.0.0.1:5174");
  assert.equal(allowed.headers.vary, "Origin");
  assert.match(allowed.headers["access-control-allow-headers"], /authorization/);
  assert.match(allowed.headers["access-control-expose-headers"], /X-Saturn-Url/);

  for (const origin of ["https://evil.example", "null", "file://"]) {
    const refused = await preflight(origin);
    assert.equal(refused.headers["access-control-allow-origin"], undefined, origin);
  }
});

test("the bind address can be a name, not only an IP address", async () => {
  const named = await startRuntime({ host: "localhost" });
  try {
    assert.deepEqual(await (await fetch(`${named.origin}/health`)).json(), { ok: true });
  } finally {
    await named.stop();
  }
});
