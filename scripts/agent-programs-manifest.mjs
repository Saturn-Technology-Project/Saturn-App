// Writes crates/saturn-core/src/agent-programs.json: for Claude Code, Codex and uv, the exact per-platform package Saturn
// downloads on demand (version, URL, sha512 integrity, and the download size for the button). Claude Code and Codex come from
// the npm registry, with the integrity the registry publishes; uv from its GitHub release, each archive downloaded here, hashed,
// and checked against the .sha256 file published beside it. Run it with the versions to move to, after trying the two programs
// against the protocol the contract tests record (contract/programs.mjs) and uv against contract/research-manage.test.mjs.
//
//   node scripts/agent-programs-manifest.mjs <claude-agent-sdk version> <codex version> <uv version>
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [claude, codex, uv] = process.argv.slice(2);
if (!claude || !codex || !uv) throw new Error("Usage: node scripts/agent-programs-manifest.mjs <claude-agent-sdk version> <codex version> <uv version>");
const REGISTRY = "https://registry.npmjs.org";
const UV_RELEASES = "https://github.com/astral-sh/uv/releases/download";
const PROGRAMS = {
  "claude-code": { name: "@anthropic-ai/claude-agent-sdk", version: claude },
  codex: { name: "@openai/codex", version: codex },
};
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
/** uv's archive for each platform Saturn names: a tar.gz with the program in a folder, a zip with it bare on Windows. */
const UV_ARCHIVES = {
  "darwin-arm64": "uv-aarch64-apple-darwin.tar.gz",
  "darwin-x64": "uv-x86_64-apple-darwin.tar.gz",
  "linux-arm64": "uv-aarch64-unknown-linux-gnu.tar.gz",
  "linux-x64": "uv-x86_64-unknown-linux-gnu.tar.gz",
  "win32-arm64": "uv-aarch64-pc-windows-msvc.zip",
  "win32-x64": "uv-x86_64-pc-windows-msvc.zip",
};

/** One platform package's pin from the npm registry, or null where none is published. */
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

/** uv's archive for a platform: downloaded whole, its sha512 taken here, and its sha256 checked against the published one. */
async function pinUv(version, platform) {
  const archive = UV_ARCHIVES[platform];
  const url = `${UV_RELEASES}/${version}/${archive}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const published = await fetch(`${url}.sha256`);
  if (!published.ok) throw new Error(`${url}.sha256: ${published.status}`);
  const expected = (await published.text()).trim().split(/\s+/)[0];
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected) throw new Error(`${archive} does not match its published sha256 (${sha256} vs ${expected})`);
  return { version, url, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, size: bytes.length };
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
manifest.uv = {};
for (const platform of PLATFORMS) manifest.uv[platform] = await pinUv(uv, platform);
const target = path.join(root, "crates/saturn-core/src/agent-programs.json");
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${target}: ${Object.entries(manifest).map(([program, platforms]) => `${program} ${Object.keys(platforms).length} platforms`).join(", ")}`);
