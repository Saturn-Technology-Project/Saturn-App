// Installs the runtime's production dependencies for another platform into .staging/runtime-<os>-<cpu>, for
// electron-builder to ship as runtime/node_modules. Claude Code and Codex come as per-platform optional packages
// (@anthropic-ai/claude-agent-sdk-win32-x64, @openai/codex-win32-x64); copying the Mac's ../runtime/node_modules
// into a Windows build would ship only the darwin ones, and both agents would report their program missing.
//
//   node scripts/stage-runtime-modules.mjs [--os win32] [--cpu x64]
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const os = option("os", "win32");
const cpu = option("cpu", "x64");

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.resolve(desktop, "..", "runtime");
const staging = path.join(desktop, ".staging", `runtime-${os}-${cpu}`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
copyFileSync(path.join(runtime, "package.json"), path.join(staging, "package.json"));
copyFileSync(path.join(runtime, "package-lock.json"), path.join(staging, "package-lock.json"));

// --ignore-scripts: install scripts would run for this machine, not the target.
execSync(`npm ci --omit=dev --os=${os} --cpu=${cpu} --ignore-scripts --no-audit --no-fund`, {
  cwd: staging,
  stdio: "inherit",
});

const required = [`@anthropic-ai/claude-agent-sdk-${os}-${cpu}`, `@openai/codex-${os}-${cpu}`];
const missing = required.filter((name) => !existsSync(path.join(staging, "node_modules", name, "package.json")));
if (missing.length) {
  console.error(`Staged runtime is missing ${missing.join(", ")}; npm did not install the ${os}-${cpu} packages.`);
  process.exit(1);
}
console.log(`  • staged runtime node_modules for ${os}-${cpu}  ${path.relative(process.cwd(), staging)}`);
