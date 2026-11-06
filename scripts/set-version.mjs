// Sets Saturn's version everywhere it is recorded, so a release changes one number in one command: the workspace version
// in Cargo.toml, desktop/package.json, and the entries for them in Cargo.lock and desktop/package-lock.json. It needs
// neither cargo nor the network. The version must be newer than the one in the files.
//
//   node scripts/set-version.mjs 0.4.2
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compare, parse } from "./release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The four files, by where they are under the repository. */
export const FILES = {
  cargoToml: "Cargo.toml",
  cargoLock: "Cargo.lock",
  packageJson: "desktop/package.json",
  packageLock: "desktop/package-lock.json",
};

const WORKSPACE_VERSION = /^(\[workspace\.package\][^[]*?^version = ")([^"]+)(")/ms;

/** The version the files say now, refusing files that disagree. */
export function currentVersion(texts) {
  const cargo = WORKSPACE_VERSION.exec(texts.cargoToml)?.[2];
  const desktop = JSON.parse(texts.packageJson).version;
  if (!cargo) throw new Error("Cargo.toml has no [workspace.package] version.");
  if (cargo !== desktop) throw new Error(`Cargo.toml says ${cargo} but desktop/package.json says ${desktop}; set them by hand to agree first.`);
  return cargo;
}

/** The four files' text with every record of the version changed to `version`. */
export function setVersion(texts, version) {
  if (!parse(version)) throw new Error(`Not a version: ${version} (expected major.minor.patch, with an optional -suffix).`);
  const current = currentVersion(texts);
  if (compare(version, current) <= 0) throw new Error(`${version} is not newer than ${current}.`);

  const cargoToml = texts.cargoToml.replace(WORKSPACE_VERSION, `$1${version}$3`);
  // The workspace's own crates are the lock file's packages with no source; only those that carry the old version move.
  let moved = 0;
  const cargoLock = texts.cargoLock.replace(
    /^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\n(?!source = )/gm,
    (block, name, old) => {
      if (old !== current) return block;
      moved += 1;
      return `[[package]]\nname = "${name}"\nversion = "${version}"\n`;
    },
  );
  if (moved === 0) throw new Error(`Cargo.lock has no workspace crate at ${current}; run cargo build first.`);

  const packageJson = JSON.parse(texts.packageJson);
  packageJson.version = version;
  const packageLock = JSON.parse(texts.packageLock);
  packageLock.version = version;
  if (packageLock.packages?.[""]) packageLock.packages[""].version = version;

  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  return { cargoToml, cargoLock, packageJson: json(packageJson), packageLock: json(packageLock) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version) {
    console.error("Usage: node scripts/set-version.mjs <version>");
    process.exit(2);
  }
  const texts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readFileSync(path.join(root, file), "utf8")]));
  const before = currentVersion(texts);
  const changed = setVersion(texts, version);
  for (const [key, file] of Object.entries(FILES)) writeFileSync(path.join(root, file), changed[key]);
  console.log(`${before} → ${version} in ${Object.values(FILES).join(", ")}.`);
  console.log(`Give the CHANGELOG a "## ${version}" section for it.`);
}
