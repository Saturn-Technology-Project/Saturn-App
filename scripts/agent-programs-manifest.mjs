// Writes crates/saturn-core/src/agent-programs.json: for Claude Code and Codex, the exact per-platform npm package Saturn downloads
// on demand (version, tarball URL, sha512 integrity from the registry), plus its download size for the Settings button. Run it with
// the versions to move to, after trying them against the protocol the contract tests record (contract/programs.mjs).
//
//   node scripts/agent-programs-manifest.mjs <claude-agent-sdk version> <codex version>
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [claude, codex] = process.argv.slice(2);
if (!claude || !codex) throw new Error("Usage: node scripts/agent-programs-manifest.mjs <claude-agent-sdk version> <codex version>");
const REGISTRY = "https://registry.npmjs.org";
const PROGRAMS = {
  "claude-code": { name: "@anthropic-ai/claude-agent-sdk", version: claude },
  codex: { name: "@openai/codex", version: codex },
};
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];

/** One platform package's pin, or null where none is published. */
async function pin(name, version, platform) {
  // Codex publishes its platforms as versions of one package; Claude Code as packages of their own.
  const candidates = name === "@openai/codex"
    ? [[name, `${version}-${platform}`], [`${name}-${platform}`, version]]
    : [[`${name}-${platform}`, version]];
  for (const [packageName, packageVersion] of candidates) {
    const response = await fetch(`${REGISTRY}/${packageName.replaceAll("/", "%2f")}/${packageVersion}`);
    if (!response.ok) continue;
    const { dist } = await response.json();
    // The registry answers HEAD without a length; a one-byte range request reports the total in Content-Range.
    const range = await fetch(dist.tarball, { headers: { range: "bytes=0-0" } });
    const size = Number(/\/(\d+)$/.exec(range.headers.get("content-range") ?? "")?.[1]) || 0;
    await range.body?.cancel();
    return { version, url: dist.tarball, integrity: dist.integrity, size };
  }
  return null;
}

const manifest = {};
for (const [program, { name, version }] of Object.entries(PROGRAMS)) {
  manifest[program] = {};
  for (const platform of PLATFORMS) {
    const item = await pin(name, version, platform);
    if (item) manifest[program][platform] = item;
  }
  if (!manifest[program]["darwin-arm64"] || !manifest[program]["win32-x64"]) throw new Error(`${name} ${version} does not cover the systems Saturn ships on`);
}
const target = path.join(root, "crates/saturn-core/src/agent-programs.json");
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${target}: ${Object.entries(manifest).map(([program, platforms]) => `${program} ${Object.keys(platforms).length} platforms`).join(", ")}`);
