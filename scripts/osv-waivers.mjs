// Writes an osv-scanner.toml next to each lock file whose advisories do not reach what Saturn ships, so OpenSSF
// Scorecard's Vulnerabilities check (and osv-scanner) report only the ones that do. An advisory in a production
// dependency of something Saturn ships is never waived here: fix it, or record it in docs/known-advisories.md.
//
//   node scripts/osv-waivers.mjs          rewrite the waivers from the OSV database
//   node scripts/osv-waivers.mjs --check  exit 1 when they are out of date
//
// Every waiver expires (IGNORE_UNTIL), so each one is looked at again. Rerun after dependency updates.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const MARK = "# Written by scripts/osv-waivers.mjs";
const IGNORE_UNTIL = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 6, 1)).toISOString().slice(0, 10);

/** Lock files whose whole tree is outside the shipped apps, and why. */
const UNSHIPPED = [
  [/^Saturn-IDE\/extensions\/copilot\//, "GitHub Copilot is neither installed nor packaged in Saturn IDE (build/npm/dirs.ts, excludedExtensions in build/lib/extensions.ts; see Saturn-IDE/UPSTREAM.md)."],
  [/^Saturn-IDE\/extensions\/vscode-api-tests\//, "A test extension, excluded from the package (excludedExtensions in build/lib/extensions.ts)."],
  [/^Saturn-IDE\/build\/agent-sdk\//, "The agent host's bundled agent CLIs, which Saturn IDE leaves out of the package (build/gulpfile.vscode.ts; see Saturn-IDE/UPSTREAM.md)."],
  [/^Saturn-IDE\/build\//, "Code-OSS build tooling: it runs on the build machine and is not part of the packaged app."],
  [/^Saturn-IDE\/cli\//, "The Rust CLI (code tunnel). Saturn builds Saturn IDE with the vscode-*-min gulp tasks, which do not build it; the app's bin/code is a shell script."],
  [/^Saturn-IDE\/(test|scripts)\/|\/test-workspace\//, "Test harness, not part of the packaged app."],
  [/^Saturn-IDE\/\.vscode\//, "A helper extension for developing Code-OSS itself, not part of the packaged app."],
];
/** Why a development-only dependency of a shipped part does not ship. */
const DEV_ONLY = {
  desktop: "A development dependency of the desktop app (build and dev tooling such as electron-builder, Vite and wait-on); electron-builder packages production dependencies only.",
  runtime: "A development dependency of the runtime (tests, type checking, lint); the packaged runtime contains production dependencies only.",
  "Saturn-IDE": "A development dependency only (build and test tooling); the packaged app contains production dependencies only (build/lib/dependencies.ts runs npm ls --omit=dev).",
};
/** Development dependencies that ship anyway: Electron is the app itself. */
const SHIPS_ANYWAY = new Set(["electron"]);

function lockFiles() {
  const patterns = [":(glob)**/package-lock.json", ":(glob)**/Cargo.lock", ":(glob)**/requirements*.txt", ":(glob)**/pyproject.toml"];
  const files = execFileSync("git", ["ls-files", "--", ...patterns], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
  return files.filter((file) => /(^|\/)(package-lock\.json|Cargo\.lock|requirements[^/]*\.txt|pyproject\.toml)$/.test(file));
}

/** Each locked package as { ecosystem, name, version, dev }. */
function packages(file) {
  const text = readFileSync(path.join(root, file), "utf8");
  if (file.endsWith("package-lock.json")) {
    return Object.entries(JSON.parse(text).packages ?? {}).flatMap(([key, entry]) => {
      if (!key || !entry.version || entry.link) return [];
      return [{ ecosystem: "npm", name: entry.name ?? key.split("node_modules/").pop(), version: entry.version, dev: Boolean(entry.dev || entry.devOptional) }];
    });
  }
  if (file.endsWith("Cargo.lock")) {
    // Crates from git count too: OSV matches them by name and version, as osv-scanner does.
    return [...text.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = /g)].map((m) => ({ ecosystem: "crates.io", name: m[1], version: m[2], dev: false }));
  }
  // Python requirements and pyproject dependencies: a range is checked at its lowest version, as osv-scanner does.
  return [...text.matchAll(/^\s*"?([A-Za-z0-9_.-]+)\s*(?:==|>=|~=)\s*([0-9][^\s;#",\]]*)/gm)].map((m) => ({ ecosystem: "PyPI", name: m[1], version: m[2], dev: true }));
}

/** OSV advisory ids for each "ecosystem name version", from the querybatch API. */
async function advisories(keys) {
  const found = new Map();
  for (let start = 0; start < keys.length; start += 1000) {
    const chunk = keys.slice(start, start + 1000);
    const response = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: chunk.map((key) => { const [ecosystem, name, version] = key.split(" "); return { package: { ecosystem, name }, version }; }) }),
    });
    if (!response.ok) throw new Error(`OSV answered ${response.status}`);
    const { results } = await response.json();
    chunk.forEach((key, index) => { const ids = (results[index].vulns ?? []).map((vuln) => vuln.id); if (ids.length) found.set(key, ids); });
  }
  return found;
}

const locks = lockFiles().map((file) => ({ file, packages: packages(file) }));
const keyOf = (item) => `${item.ecosystem} ${item.name} ${item.version}`;
const found = await advisories([...new Set(locks.flatMap((lock) => lock.packages.map(keyOf)))].sort());

// One waiver file per folder: every lock file in it shares the file.
const folders = new Map();
for (const lock of locks) {
  const folder = path.dirname(lock.file);
  const unshipped = UNSHIPPED.find(([pattern]) => pattern.test(lock.file))?.[1];
  const devReason = DEV_ONLY[lock.file.split("/")[0]];
  const shipped = new Set();
  const waived = new Map();
  for (const item of lock.packages) {
    for (const id of found.get(keyOf(item)) ?? []) {
      if (unshipped) waived.set(id, unshipped);
      else if (!item.dev || SHIPS_ANYWAY.has(item.name)) shipped.add(id);
      else if (devReason) waived.set(id, devReason);
    }
  }
  for (const id of shipped) waived.delete(id);
  const entries = folders.get(folder) ?? new Map();
  for (const [id, reason] of waived) entries.set(id, reason);
  folders.set(folder, entries);
}

let stale = 0;
for (const [folder, entries] of [...folders].sort()) {
  const target = path.join(root, folder, "osv-scanner.toml");
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch {}
  if (current && !current.startsWith(MARK)) { console.warn(`skipped ${folder}/osv-scanner.toml: not written by this script`); continue; }
  const keep = new Map([...current.matchAll(/id = "([^"]+)"\nignoreUntil = (\S+)/g)].map((m) => [m[1], m[2]]));
  const body = [...entries].sort().map(([id, reason]) => `[[IgnoredVulns]]\nid = "${id}"\nignoreUntil = ${keep.get(id) ?? IGNORE_UNTIL}\nreason = ${JSON.stringify(reason)}\n`).join("\n");
  const next = entries.size ? `${MARK}; rerun it after dependency updates.\n\n${body}` : "";
  if (next === current) continue;
  stale += 1;
  if (check) { console.log(`out of date: ${folder}/osv-scanner.toml`); continue; }
  if (next) writeFileSync(target, next);
  else rmSync(target);
  console.log(`${next ? "wrote" : "removed"} ${folder}/osv-scanner.toml (${entries.size})`);
}
if (check && stale) process.exit(1);
