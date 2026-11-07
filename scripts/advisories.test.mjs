// The advisories left open are the same in the three places that list them: deny.toml (cargo deny), osv-scanner.toml
// (OSV-Scanner and OpenSSF Scorecard) and docs/known-advisories.md (people), and none is kept past its date.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ids = (text) => new Set(text.match(/\b(?:RUSTSEC-\d{4}-\d{4}|GHSA(?:-[0-9a-z]{4}){3})\b/g) ?? []);

test("every advisory left open is listed for cargo deny, for OSV and Scorecard, and for people", async () => {
  const deny = await readFile("deny.toml", "utf8");
  const osv = await readFile("osv-scanner.toml", "utf8");
  const docs = await readFile("docs/known-advisories.md", "utf8");
  const ignoredByDeny = ids(deny.slice(deny.indexOf("ignore = ["), deny.indexOf("]", deny.indexOf("ignore = ["))));
  const ignoredByOsv = new Set([...osv.matchAll(/^id = "([^"]+)"/gm)].map((match) => match[1]));
  for (const id of ignoredByDeny) assert.ok(ignoredByOsv.has(id), `${id} is ignored by cargo deny but not in osv-scanner.toml`);
  for (const id of ignoredByOsv) assert.ok(ids(docs).has(id), `${id} is ignored in osv-scanner.toml but not explained in docs/known-advisories.md`);
});

test("an advisory is ignored only until a date, and that date has not passed", async () => {
  const osv = await readFile("osv-scanner.toml", "utf8");
  const entries = osv.split("[[IgnoredVulns]]").slice(1);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    const id = /^id = "([^"]+)"/m.exec(entry)?.[1];
    const until = /^ignoreUntil = (\d{4}-\d{2}-\d{2})$/m.exec(entry)?.[1];
    assert.ok(until, `${id} has no ignoreUntil`);
    assert.ok(/^reason = ".+"$/m.test(entry), `${id} has no reason`);
    assert.ok(new Date(`${until}T00:00:00Z`) > new Date(), `${id} was to be looked at again by ${until}: check it, then move the date or fix it`);
  }
});
