// Writes one CycloneDX 1.5 SBOM for a Saturn release: the crates of the runtime and the app (from Cargo.lock), the npm packages
// the interface ships (from its lock file), without installing anything, plus the bundled embedding model with its pinned hashes.
//
//   node scripts/sbom.mjs <version> <output.cdx.json>
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [version = "0.0.0", output = "saturn.cdx.json"] = process.argv.slice(2);

/**
 * The production packages of one npm project, as CycloneDX components, read straight from its lock file: name,
 * version, package URL, license, and the SHA-512 the lock file pins (the registry tarball's integrity).
 */
function npmComponents(dir) {
  const lock = JSON.parse(readFileSync(path.join(root, dir, "package-lock.json"), "utf8"));
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.includes("node_modules/") || entry.dev || entry.link || !entry.version) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const purl = `pkg:npm/${name.replace(/^@/, "%40")}@${entry.version}`;
    const sha512 = /(?:^|\s)sha512-([A-Za-z0-9+/=]+)/.exec(entry.integrity ?? "")?.[1];
    out.push({
      type: "library",
      name,
      version: entry.version,
      purl,
      ...(entry.license ? { licenses: [{ expression: String(entry.license) }] } : {}),
      ...(sha512 ? { hashes: [{ alg: "SHA-512", content: Buffer.from(sha512, "base64").toString("hex") }] } : {}),
      ...(entry.resolved ? { externalReferences: [{ type: "distribution", url: entry.resolved }] } : {}),
    });
  }
  return out;
}

/** Every crate from crates.io in the lock file, as CycloneDX components, with the sha256 Cargo pins. */
function crateComponents() {
  const lock = readFileSync(path.join(root, "Cargo.lock"), "utf8");
  return [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = "registry\+[^"]+"\nchecksum = "([0-9a-f]{64})"/g)].map(([, name, version, sum]) => ({
    type: "library",
    name,
    version,
    purl: `pkg:cargo/${name}@${version}`,
    hashes: [{ alg: "SHA-256", content: sum }],
    externalReferences: [{ type: "distribution", url: `https://crates.io/crates/${name}/${version}` }],
  }));
}

const components = new Map();
for (const [project, found] of [["desktop", npmComponents("desktop")], ["crates", crateComponents()]]) {
  for (const component of found) {
    components.set(component.purl, { ...component, "bom-ref": component.purl, properties: [{ name: "saturn:project", value: project }] });
  }
}

// The embedding model, pinned by sha256 in desktop/scripts/fetch-embedding-model.mjs.
const fetchScript = readFileSync(path.join(root, "desktop", "scripts", "fetch-embedding-model.mjs"), "utf8");
const repo = /const REPO = "([^"]+)"/.exec(fetchScript)?.[1] ?? "";
const hashes = [...fetchScript.matchAll(/"([^"]+)": "([0-9a-f]{64})"/g)];
components.set(`pkg:huggingface/${repo}`, {
  type: "machine-learning-model", name: repo, purl: `pkg:huggingface/${repo}`, "bom-ref": `pkg:huggingface/${repo}`,
  licenses: [{ license: { id: "MIT" } }],
  hashes: hashes.filter(([, file]) => file.endsWith(".onnx")).map(([, , sum]) => ({ alg: "SHA-256", content: sum })),
  properties: hashes.map(([, file, sum]) => ({ name: `saturn:file:${file}`, value: `sha256:${sum}` })),
});

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: "Saturn", name: "scripts/sbom.mjs" }],
    component: { type: "application", name: "Saturn", version, purl: `pkg:github/Saturn-Technology-Project/Saturn-App@v${version}`, "bom-ref": "saturn" },
  },
  components: [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl)),
};
writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`${output}: ${sbom.components.length} components`);
