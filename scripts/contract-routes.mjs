// Lists every HTTP route of the TypeScript runtime in contract/routes.json, the checklist for the Rust runtime: a route
// added to one must reach the other.
//
//   node scripts/contract-routes.mjs          rewrite the list
//   node scripts/contract-routes.mjs --check  exit 1 when it is out of date
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const presentation = path.join(root, "runtime/src/presentation");
const target = path.join(root, "contract/routes.json");

const routes = readdirSync(presentation)
  .filter((file) => file.endsWith(".ts"))
  .flatMap((file) => {
    const source = readFileSync(path.join(presentation, file), "utf8");
    return [...source.matchAll(/\bapp\.(get|post|put|patch|delete|all)\(\s*(?:"([^"]+)"|\[([^\]]+)\]|([A-Z_]+))/g)].flatMap((match) => {
      // One path, a list of paths, or a path named by a constant in the same file, such as AGENT_SKILLS_PATH.
      const named = match[4] && new RegExp(`${match[4]}\\s*=\\s*"([^"]+)"`).exec(source)?.[1];
      const paths = match[2] ? [match[2]] : match[3] ? [...match[3].matchAll(/"([^"]+)"/g)].map((item) => item[1]) : named ? [named] : [];
      if (!paths.length) throw new Error(`${file}: cannot read the path of app.${match[1]}(${match[4]})`);
      return paths.map((route) => `${match[1].toUpperCase()} ${route}`);
    });
  });
const next = `${JSON.stringify([...new Set(routes)].sort(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // No list yet: out of date.
  }
  if (current !== next) {
    console.error("contract/routes.json is out of date: run node scripts/contract-routes.mjs");
    process.exit(1);
  }
  console.log(`contract/routes.json: ${JSON.parse(next).length} routes, up to date`);
} else {
  writeFileSync(target, next);
  console.log(`contract/routes.json: ${JSON.parse(next).length} routes`);
}
