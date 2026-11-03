import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
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
