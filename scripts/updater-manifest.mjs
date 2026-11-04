// Writes the latest.json installed Saturns check, from the updater-<platform>.json entry each release job left.
//
//   node scripts/updater-manifest.mjs <version> <folder> <output>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [version, folder, output] = process.argv.slice(2);
const platforms = {};
for (const name of readdirSync(folder).filter((item) => /^updater-.+\.json$/.test(item))) {
  const { platform, signature, url } = JSON.parse(readFileSync(path.join(folder, name), "utf8"));
  platforms[platform] = { signature, url };
}
writeFileSync(output, `${JSON.stringify({ version, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
console.log(`${output}: ${version} for ${Object.keys(platforms).join(", ")}`);
