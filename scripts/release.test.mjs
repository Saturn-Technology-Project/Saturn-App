// The release decisions a push makes: which version, whether it releases, and what its notes say.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changes, notes } from "./release-notes.mjs";
import { compare, decide, isPrerelease } from "./release-version.mjs";
import { setVersion } from "./set-version.mjs";

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

/** The four files a version lives in, small, at 0.4.0, with a crates.io crate at the same version. */
function versionFiles({ desktop = "0.4.0" } = {}) {
  return {
    cargoToml: '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.4.0"\nedition = "2024"\n\n[workspace.dependencies]\nserde = "1"\n',
    cargoLock: [
      "version = 4",
      '[[package]]\nname = "saturn-core"\nversion = "0.4.0"\ndependencies = [\n "same",\n]',
      '[[package]]\nname = "same"\nversion = "0.4.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "00"',
      '[[package]]\nname = "saturn-server"\nversion = "0.4.0"',
    ].join("\n\n") + "\n",
    packageJson: `${JSON.stringify({ name: "@saturn/desktop", version: desktop, private: true }, null, 2)}\n`,
    packageLock: `${JSON.stringify({ name: "@saturn/desktop", version: desktop, lockfileVersion: 3, packages: { "": { name: "@saturn/desktop", version: desktop }, "node_modules/same": { version: "0.4.0" } } }, null, 2)}\n`,
  };
}

test("one command moves the version in every file that records it, and nothing else", () => {
  const changed = setVersion(versionFiles(), "0.4.1");
  assert.match(changed.cargoToml, /\[workspace\.package\]\nversion = "0\.4\.1"/);
  assert.match(changed.cargoToml, /serde = "1"/);
  assert.match(changed.cargoLock, /name = "saturn-core"\nversion = "0\.4\.1"/);
  assert.match(changed.cargoLock, /name = "saturn-server"\nversion = "0\.4\.1"/);
  assert.match(changed.cargoLock, /name = "same"\nversion = "0\.4\.0"\nsource/, "a crate from crates.io keeps its version");
  assert.equal(JSON.parse(changed.packageJson).version, "0.4.1");
  const lock = JSON.parse(changed.packageLock);
  assert.deepEqual([lock.version, lock.packages[""].version, lock.packages["node_modules/same"].version], ["0.4.1", "0.4.1", "0.4.0"]);
  assert.equal(setVersion(versionFiles(), "1.0.0-rc.1").cargoToml.includes('version = "1.0.0-rc.1"'), true);
});

test("a version that is not newer, not a version, or files that disagree are refused", () => {
  assert.throws(() => setVersion(versionFiles(), "0.4.0"), /not newer than 0\.4\.0/);
  assert.throws(() => setVersion(versionFiles(), "0.3.9"), /not newer/);
  assert.throws(() => setVersion(versionFiles(), "0.5"), /Not a version/);
  assert.throws(() => setVersion(versionFiles({ desktop: "0.3.0" }), "0.4.1"), /Cargo\.toml says 0\.4\.0 but desktop\/package\.json says 0\.3\.0/);
});
