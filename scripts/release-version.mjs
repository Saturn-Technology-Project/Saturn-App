// Decides whether a push releases, and as which version. The version is desktop/package.json's, which must match the
// workspace version in Cargo.toml. A push releases when that version is newer than every v* tag; a v* tag push releases
// its own version, which must match the files.
//
//   node scripts/release-version.mjs [--tag v1.2.3]     prints version=…, release=true|false, prerelease=…, reason=…
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A version's parts, or null when it is not `major.minor.patch` with an optional `-suffix`. */
export function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  return match ? { numbers: match.slice(1, 4).map(Number), suffix: match[4] ?? null } : null;
}

/** Below zero when left is older than right, above zero when newer, as semantic versioning orders them. */
export function compare(left, right) {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error(`Not a version: ${a ? right : left}`);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.suffix === b.suffix) return 0;
  // A version with a suffix (1.0.0-rc.1) comes before the same version without one.
  if (!a.suffix) return 1;
  if (!b.suffix) return -1;
  return a.suffix < b.suffix ? -1 : 1;
}

/** 0.x and suffixed versions are pre-releases. */
export function isPrerelease(version) {
  return version.startsWith("0.") || version.includes("-");
}

/** What a push of these files, with these tags, should do. */
export function decide({ packageVersion, cargoVersion, tags, pushedTag }) {
  if (packageVersion !== cargoVersion) {
    throw new Error(`desktop/package.json says ${packageVersion} but Cargo.toml says ${cargoVersion}: set both with node scripts/set-version.mjs <version>.`);
  }
  if (!parse(packageVersion)) throw new Error(`Not a version: ${packageVersion}`);
  const prerelease = isPrerelease(packageVersion);
  if (pushedTag) {
    if (pushedTag !== `v${packageVersion}`) throw new Error(`The tag ${pushedTag} does not match the version in the files, ${packageVersion}.`);
    return { version: packageVersion, release: true, prerelease, reason: `the tag ${pushedTag} was pushed` };
  }
  const released = tags.map((tag) => tag.replace(/^v/, "")).filter((version) => parse(version));
  if (released.includes(packageVersion)) return { version: packageVersion, release: false, prerelease, reason: `v${packageVersion} is already released` };
  const newest = released.sort(compare).at(-1);
  if (newest && compare(packageVersion, newest) < 0) {
    throw new Error(`The version ${packageVersion} is older than the newest release, v${newest}: raise it with node scripts/set-version.mjs <version>.`);
  }
  return { version: packageVersion, release: true, prerelease, reason: newest ? `${packageVersion} is newer than v${newest}` : "there is no release yet" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tagIndex = process.argv.indexOf("--tag");
  const pushedTag = tagIndex > 0 ? process.argv[tagIndex + 1] : null;
  const packageVersion = JSON.parse(readFileSync(path.join(root, "desktop", "package.json"), "utf8")).version;
  const cargoVersion = /^\[workspace\.package\][^[]*?^version = "([^"]+)"/ms.exec(readFileSync(path.join(root, "Cargo.toml"), "utf8"))?.[1];
  const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const decision = decide({ packageVersion, cargoVersion, tags, pushedTag });
  const lines = Object.entries(decision).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  process.stdout.write(lines);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
}
