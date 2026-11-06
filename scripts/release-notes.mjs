// Writes a release's notes: the install instructions in .github/release-notes.md, then what changed, from the
// CHANGELOG section for this version, or the Unreleased one when there is none yet.
//
//   node scripts/release-notes.mjs 1.2.3 notes.md
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The body of the CHANGELOG section for this version, or of Unreleased, without its heading; empty when neither exists. */
export function changes(changelog, version) {
  const sections = changelog.split(/^## /m).slice(1);
  const pick = (test) => sections.find((section) => test(section.split("\n")[0].trim()));
  const found = pick((heading) => heading === version || heading.startsWith(`${version} `)) ?? pick((heading) => /^unreleased\b/i.test(heading));
  return found ? found.slice(found.indexOf("\n") + 1).trim() : "";
}

/** The whole notes for a version. */
export function notes(template, changelog, version) {
  const install = template.replaceAll("__VERSION__", version).trim();
  const changed = changes(changelog, version);
  return `${install}\n\n## What changed\n\n${changed || "See the commits below."}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, out] = process.argv.slice(2);
  if (!version || !out) throw new Error("Usage: node scripts/release-notes.mjs <version> <out>");
  const template = readFileSync(path.join(root, ".github", "release-notes.md"), "utf8");
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  writeFileSync(out, notes(template, changelog, version));
}
