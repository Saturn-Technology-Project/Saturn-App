// Checks npm lock files for the ways a dependency can slip past the registry's guarantees: every package must
// resolve to https://registry.npmjs.org/ and carry a sha512 integrity, so `npm ci` installs exactly the bytes that
// were reviewed. Git, tarball-URL, http and file dependencies are refused unless listed below with a reason.
//
//   node scripts/check-lockfiles.mjs [lockfile ...]   (default: runtime, desktop and Saturn IDE)
import { readFileSync } from "node:fs";

const REGISTRY = "https://registry.npmjs.org/";
/** Packages allowed to come from elsewhere, by lock path, with why. Empty means none. */
const EXCEPTIONS = {};

const files = process.argv.slice(2).length ? process.argv.slice(2) : ["runtime/package-lock.json", "desktop/package-lock.json", "Saturn-IDE/package-lock.json"];
let problems = 0;
for (const file of files) {
  const lock = JSON.parse(readFileSync(file, "utf8"));
  if (lock.lockfileVersion < 2) {
    console.error(`${file}: lockfileVersion ${lock.lockfileVersion} has no integrity for every package; regenerate it with npm 7 or later`);
    problems += 1;
    continue;
  }
  let checked = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key || entry.link || !key.includes("node_modules/")) continue; // the root, workspace links, local workspaces
    if (EXCEPTIONS[`${file}:${key}`]) continue;
    checked += 1;
    const where = `${file}: ${key.replace(/^.*node_modules\//, "")}@${entry.version ?? "?"}`;
    if (!entry.resolved) {
      if (entry.inBundle) continue; // shipped inside its parent's tarball, covered by the parent's integrity
      console.error(`${where} has no resolved URL`);
      problems += 1;
    } else if (!entry.resolved.startsWith(REGISTRY)) {
      console.error(`${where} comes from ${entry.resolved.split("#")[0]}, not the npm registry`);
      problems += 1;
    } else if (!/(^|\s)sha512-/.test(entry.integrity ?? "")) {
      console.error(`${where} has no sha512 integrity (${entry.integrity ?? "none"})`);
      problems += 1;
    }
  }
  console.log(`${file}: ${checked} packages, all from the npm registry with sha512 integrity${problems ? " (see above)" : ""}`);
}
if (problems) {
  console.error(`${problems} problem${problems === 1 ? "" : "s"}`);
  process.exit(1);
}
