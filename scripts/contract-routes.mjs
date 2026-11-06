// Lists every HTTP route of the runtime in contract/routes.json, so a route never changes without a look at who depends on it.
//
//   node scripts/contract-routes.mjs          rewrite the list
//   node scripts/contract-routes.mjs --check  exit 1 when it is out of date
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "crates/saturn-server/src");
const target = path.join(root, "contract/routes.json");

// Each .route("/path", get(a).post(b)) in the router; `fallback` answers every other method.
const routes = readdirSync(server)
  .filter((file) => file.endsWith(".rs"))
  .flatMap((file) => {
    const source = readFileSync(path.join(server, file), "utf8");
    return [...source.matchAll(/\.route\(\s*"([^"]+)"\s*,\s*((?:[^()]|\([^()]*\))*)\)/g)].flatMap((match) => {
      const route = match[1].replace(/\{(\w+)\}/g, ":$1");
      return [...match[2].matchAll(/\b(get|post|put|patch|delete|any|fallback)\(/g)].map(([, method]) => `${method === "any" || method === "fallback" ? "ALL" : method.toUpperCase()} ${route}`);
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
