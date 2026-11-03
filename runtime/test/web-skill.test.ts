import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { fetchPublic, publicLookup, requestThrough } from "../src/infrastructure/public-host.js";
import { pageText, WebSkill } from "../src/infrastructure/skills/web-skill.js";

test("the web tool does not reach this computer through an IPv6 spelling of its address", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("local only");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) {
      await assert.rejects(() => new WebSkill().run({ url: `http://${host}:${address.port}/` }), /not allowed/, host);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("page text decodes entities once and drops scripts and styles however their end tags are written", () => {
  assert.equal(pageText("<title>a &amp;lt; b</title>").title, "a &lt; b");
  assert.equal(pageText("<p>&lt;b&gt; &quot;x&quot; &#39;y&#39; &amp;&nbsp;z</p>").text, "<b> \"x\" 'y' & z");
  assert.equal(pageText("<p>kept</p><script>hidden()</script ><style>.hidden {}</style\n><script src=x></script>").text, "kept");
  assert.equal(pageText("<scripted>kept</scripted>").text, "kept");
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

test("a name is checked in the connection's own lookup, once, so it cannot change its answer afterwards", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("local only");
  });
  const port = await listen(server);
  let lookups = 0;
  // Public to a check made first, then this computer for the connection.
  const rebinding = (async () => [{ address: (lookups += 1) === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }]) as never;
  const refusing = (async () => [{ address: "127.0.0.1", family: 4 }]) as never;
  try {
    await assert.rejects(() => fetchPublic(new URL(`http://rebind.example:${port}/`), {}, refusing), /not allowed/);
    await assert.rejects(() => fetchPublic(new URL(`http://[::ffff:7f00:1]:${port}/`), {}, refusing), /not allowed/);
    assert.equal(requests, 0);
    const answers = await new Promise<unknown>((resolve, reject) => {
      publicLookup(rebinding)("rebind.example", { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
    });
    assert.deepEqual(answers, [{ address: "8.8.8.8", family: 4 }]);
    assert.equal(lookups, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a page comes back as a fetch Response: decompressed, with its status and headers, redirects not followed", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/moved") {
      response.writeHead(302, { location: "/next" }).end();
    } else if (request.url === "/empty") {
      response.writeHead(204).end();
    } else {
      response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "x-agent": String(request.headers["user-agent"]) }).end(gzipSync("<p>hello</p>"));
    }
  });
  const port = await listen(server);
  const toThisComputer = ((_hostname: string, options: { all?: boolean }, callback: (error: null, address: unknown, family?: number) => void) => {
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  }) as never;
  try {
    const page = await requestThrough(new URL(`http://app.example:${port}/`), { headers: { "user-agent": "Saturn test" } }, toThisComputer);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-agent"), "Saturn test");
    assert.equal(await page.text(), "<p>hello</p>");
    const moved = await requestThrough(new URL(`http://app.example:${port}/moved`), {}, toThisComputer);
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get("location"), "/next");
    await moved.body?.cancel();
    assert.equal((await requestThrough(new URL(`http://app.example:${port}/empty`), {}, toThisComputer)).status, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
