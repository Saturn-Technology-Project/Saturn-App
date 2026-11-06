// The release decisions a push makes: which version, whether it releases, and what its notes say.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changes, notes } from "./release-notes.mjs";
import { compare, decide, isPrerelease } from "./release-version.mjs";

test("versions order as semantic versioning says", () => {
  assert.ok(compare("0.4.0", "0.3.1") > 0);
  assert.ok(compare("0.10.0", "0.9.9") > 0);
  assert.ok(compare("1.0.0-rc.1", "1.0.0") < 0);
  assert.equal(compare("1.2.3", "1.2.3"), 0);
  assert.throws(() => compare("1.2", "1.2.3"));
});

test("a push releases a version newer than every tag, once", () => {
  const tags = ["v0.2.0", "v0.3.1", "v0.3.0", "updates"];
  assert.deepEqual(decide({ packageVersion: "0.4.0", cargoVersion: "0.4.0", tags }), { version: "0.4.0", release: true, prerelease: true, reason: "0.4.0 is newer than v0.3.1" });
  assert.equal(decide({ packageVersion: "0.3.1", cargoVersion: "0.3.1", tags }).release, false);
  assert.throws(() => decide({ packageVersion: "0.1.0", cargoVersion: "0.1.0", tags }), /older than the newest release, v0\.3\.1/);
  assert.throws(() => decide({ packageVersion: "0.4.0", cargoVersion: "0.1.0", tags }), /Cargo\.toml says 0\.1\.0/);
  assert.equal(decide({ packageVersion: "1.0.0", cargoVersion: "1.0.0", tags: [] }).prerelease, false);
});

test("a pushed tag must match the files", () => {
  assert.equal(decide({ packageVersion: "0.4.0", cargoVersion: "0.4.0", tags: ["v0.4.0"], pushedTag: "v0.4.0" }).release, true);
  assert.throws(() => decide({ packageVersion: "0.4.0", cargoVersion: "0.4.0", tags: [], pushedTag: "v0.5.0" }), /does not match/);
  assert.equal(isPrerelease("1.0.0-rc.1"), true);
});

test("notes take the version's CHANGELOG section, or Unreleased", () => {
  const changelog = "# Changelog\n\nIntro.\n\n## Unreleased\n\n### Added\n\n- New thing.\n\n## 0.3.1 (2026-10-22)\n\n### Fixed\n\n- Old fix.\n";
  assert.equal(changes(changelog, "0.3.1"), "### Fixed\n\n- Old fix.");
  assert.equal(changes(changelog, "0.4.0"), "### Added\n\n- New thing.");
  assert.equal(changes("# Changelog\n", "0.4.0"), "");
  const written = notes("Download Saturn-__VERSION__.dmg.", changelog, "0.4.0");
  assert.match(written, /^Download Saturn-0\.4\.0\.dmg\.\n\n## What changed\n\n### Added/);
});
