// Installs the runtime's production dependencies for a target platform into .staging/runtime-<os>-<cpu>, for
// electron-builder to ship as runtime/node_modules. A clean production install leaves out the dev tools
// (TypeScript, esbuild, tsx), and the Claude Code and Codex programs are left for Saturn to download on demand.
// Files nothing loads at run time are then removed: source maps, type declarations and TypeScript sources, plus
// other platforms' ONNX Runtime binaries.
//
//   node scripts/stage-runtime-modules.mjs [--os win32|darwin] [--cpu x64|arm64]   (default: this machine)
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const os = option("os", process.platform);
const cpu = option("cpu", process.arch);

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

// Claude Code and Codex are downloaded on demand (Settings → General), not shipped: drop their platform packages,
// about 530 MB unpacked. The SDKs that drive them stay; the runtime points them at the downloaded program.
const scopes = { "@anthropic-ai": /^claude-agent-sdk-(darwin|linux|win32)-/, "@openai": /^codex-(darwin|linux|win32)-/ };
for (const [scope, pattern] of Object.entries(scopes)) {
  const dir = path.join(staging, "node_modules", scope);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (pattern.test(name)) rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}
for (const name of ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"]) {
  if (!existsSync(path.join(staging, "node_modules", name, "package.json"))) {
    console.error(`Staged runtime is missing ${name}.`);
    process.exit(1);
  }
}
// ONNX Runtime (the built-in embedding model) ships every platform's binaries; keep only the target's.
const onnx = path.join(staging, "node_modules", "onnxruntime-node", "bin");
if (existsSync(onnx)) {
  for (const napi of readdirSync(onnx)) {
    for (const platform of readdirSync(path.join(onnx, napi))) {
      for (const arch of readdirSync(path.join(onnx, napi, platform))) {
        if (platform !== os || arch !== cpu) rmSync(path.join(onnx, napi, platform, arch), { recursive: true, force: true });
      }
      if (platform !== os) rmSync(path.join(onnx, napi, platform), { recursive: true, force: true });
    }
  }
}

// libonnxruntime.1.dylib and libonnxruntime.1.<version>.dylib are the same library, copied rather than linked in the
// npm package; the binding links the short name.
const onnxTarget = path.join(onnx, "napi-v6", os, cpu);
if (existsSync(onnxTarget)) {
  for (const file of readdirSync(onnxTarget)) {
    if (/^libonnxruntime\.1\.\d+\.\d+\.dylib$/.test(file) && existsSync(path.join(onnxTarget, "libonnxruntime.1.dylib"))) rmSync(path.join(onnxTarget, file));
  }
}

// Source maps, type declarations and TypeScript sources. Packages that point an export at a .ts file do so only under
// build-tool conditions ("source", "@zod/source") that Node never resolves.
const unused = /\.(map|ts|mts|cts)$/;
let removed = 0;
let bytes = 0;
function prune(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) prune(file);
    else if (entry.isFile() && unused.test(entry.name)) {
      bytes += statSync(file).size;
      rmSync(file);
      removed += 1;
    }
  }
}
prune(path.join(staging, "node_modules"));
console.log(`  • removed ${removed} source map, declaration and TypeScript files (${Math.round(bytes / 1048576)} MB)`);

console.log(`  • staged runtime node_modules for ${os}-${cpu}  ${path.relative(process.cwd(), staging)}`);
