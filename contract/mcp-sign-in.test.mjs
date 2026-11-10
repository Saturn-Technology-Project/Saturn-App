// A browser sign-in to an MCP server, end to end: Saturn registers with the server's authorization server and opens its
// sign-in page; the browser comes back to /oauth/callback, which carries no token, and finishes only a sign-in Saturn
// started, once. The browser is a stand-in that writes down what it was asked to open.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { startWithPrograms } from "./programs.mjs";

/** An MCP server that wants a bearer token, and the authorization server that gives one for the code "the-code". */
async function signedServer() {
  const forms = [];
  let base = "";
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const json = (status, body, headers = {}) => response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
      const url = new URL(request.url, base);
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
      if (url.pathname === "/register") return json(201, { client_id: "registered-client" });
      if (url.pathname === "/token") {
        forms.push(raw);
        return new URLSearchParams(raw).get("code") === "the-code" ? json(200, { access_token: "first-token" }) : json(400, { error: "invalid_grant" });
      }
      if (url.pathname === "/mcp") {
        if (request.headers.authorization !== "Bearer first-token") {
          return response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
        }
        const message = JSON.parse(raw);
        if (message.id === undefined) return response.writeHead(202).end();
        const result = message.method === "initialize"
          ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "signed", version: "1" } }
          : { tools: [{ name: "lookup", description: "Looks something up", inputSchema: { type: "object", properties: {} } }] };
        return json(200, { jsonrpc: "2.0", id: message.id, result });
      }
      response.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, forms, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test("a browser sign-in finishes at the callback, without the token, only for a sign-in Saturn started, and once", async () => {
  const saturn = await startWithPrograms({ install: [] });
  const remote = await signedServer();
  try {
    // Added as any server is: connecting finds that it signs in with OAuth and opens its page.
    const server = await saturn.api("POST", "/connections/mcp", { name: "Signed", url: `${remote.base}/mcp` });
    const asked = await saturn.call("POST", `/connections/mcp/${server.id}/discover`, {});
    assert.equal(asked.status, 409);
    assert.match(asked.body.error, /finish it in the browser page that opened/);
    const opened = await saturn.until("the sign-in page", () => saturn.opened(), (pages) => pages.length > 0);
    const page = new URL(opened.at(-1));
    assert.equal(page.origin + page.pathname, `${remote.base}/authorize`);
    assert.equal(page.searchParams.get("code_challenge_method"), "S256");
    const callback = new URL(page.searchParams.get("redirect_uri"));
    assert.equal(callback.pathname, "/oauth/callback");
    const back = (query) => fetch(`${saturn.origin}/oauth/callback?${new URLSearchParams(query)}`).then(async (response) => ({ status: response.status, csp: response.headers.get("content-security-policy"), text: await response.text() }));

    // A state Saturn did not start finishes nothing, and asks the token server nothing.
    const forged = await back({ state: "made-up", code: "the-code" });
    assert.equal(forged.status, 200);
    assert.match(forged.text, /Sign-in was not completed/);
    assert.equal(remote.forms.length, 0);

    // The provider's own refusal is shown as such.
    assert.match((await back({ error: "access_denied", error_description: "<b>no</b>" })).text, /The server said: &lt;b&gt;no&lt;\/b&gt;/);

    const state = page.searchParams.get("state");
    const done = await back({ state, code: "the-code" });
    assert.match(done.text, /Signed in/);
    assert.match(done.csp, /default-src 'none'/, "the page runs nothing");
    assert.match(remote.forms[0], /code_verifier=/, "the code is exchanged with the sign-in's own PKCE verifier");
    const tools = await saturn.api("POST", `/connections/mcp/${server.id}/discover`, {});
    assert.ok(JSON.stringify(tools).includes("lookup"), JSON.stringify(tools));

    assert.match((await back({ state, code: "the-code" })).text, /Sign-in was not completed/, "a state finishes one sign-in only");
    // fetch will not send another Host; a plain request can, as a page reached through DNS rebinding would.
    const rebound = await new Promise((resolve, reject) => {
      const address = new URL(saturn.origin);
      request({ host: address.hostname, port: address.port, path: "/oauth/callback?state=x", headers: { host: "evil.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject).end();
    });
    assert.equal(rebound, 403, "the Host check still holds");
  } finally {
    await remote.close();
    await saturn.stop();
  }
});
