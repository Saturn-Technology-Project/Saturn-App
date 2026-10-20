// electron-builder afterPack hook: puts the Saturn IDE build (the Code-OSS fork in ../Saturn-IDE) inside the
// app's resources, so "Open IDE" works without a separate install: Saturn.app/Contents/Resources/Saturn IDE.app
// on macOS (ditto keeps the bundle's framework symlinks and permissions, which extraResources does not), and
// resources/Saturn IDE/ (a folder with Saturn IDE.exe or saturn-ide) on Windows and Linux.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ARCHES = { 1: "x64", 3: "arm64" };

const LAYOUT = {
  darwin: { build: (arch) => `VSCode-darwin-${arch}`, inBuild: "Saturn IDE.app", product: ["Contents", "Resources", "app", "product.json"], target: "Saturn IDE.app" },
  win32: { build: (arch) => `VSCode-win32-${arch}`, inBuild: "", product: ["resources", "app", "product.json"], target: "Saturn IDE" },
  linux: { build: (arch) => `VSCode-linux-${arch}`, inBuild: "", product: ["resources", "app", "product.json"], target: "Saturn IDE" },
};

exports.default = async function bundleIde(context) {
  const platform = context.electronPlatformName;
  const layout = LAYOUT[platform];
  if (!layout) return;
  const arch = ARCHES[context.arch] ?? "arm64";
  const source = process.env.SATURN_IDE_BUILD || path.resolve(__dirname, "..", "..", layout.build(arch), layout.inBuild);
  const appFile = `${context.packager.appInfo.productFilename}.app`;
  if (!fs.existsSync(source)) {
    if (process.env.SATURN_SKIP_IDE === "1") {
      console.warn(`  • Saturn IDE not bundled: ${source} is missing (SATURN_SKIP_IDE=1)`);
      if (platform === "darwin") adHocSign(path.join(context.appOutDir, appFile));
      return;
    }
    throw new Error(
      `Saturn IDE build not found at ${source}. Run "npm run build:ide" (macOS) or "npm run build:ide:win" (Windows) first, or set SATURN_SKIP_IDE=1 to package without it.`,
    );
  }
  // A build without its commit takes itself for a dev build at run time (it loads node_modules instead of
  // node_modules.asar, and the terminal, tree-sitter and more are missing). Refuse to ship one.
  const product = JSON.parse(fs.readFileSync(path.join(source, ...layout.product), "utf8"));
  if (!/^[0-9a-f]{40}$/.test(String(product.commit || ""))) {
    throw new Error(`Saturn IDE at ${source} has no commit in its product.json; its build did not find the git repository. Rebuild it.`);
  }
  if (platform === "darwin") {
    const app = path.join(context.appOutDir, appFile);
    const target = path.join(app, "Contents", "Resources", layout.target);
    fs.rmSync(target, { recursive: true, force: true });
    execFileSync("ditto", [source, target]);
    console.log(`  • bundled Saturn IDE  ${path.relative(process.cwd(), target)}`);
    adHocSign(target);
    adHocSign(app);
    return;
  }
  const target = path.join(context.appOutDir, "resources", layout.target);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true, dereference: false });
  console.log(`  • bundled Saturn IDE  ${path.relative(process.cwd(), target)}`);
};

/**
 * Without a signing identity, Electron's binaries keep only their linker signature and the bundle's resources
 * are unsealed, so a downloaded (quarantined) copy is reported as "damaged". An ad-hoc signature over the whole
 * bundle makes macOS offer "Open Anyway" instead. Builds signed with a real identity are left to electron-builder.
 */
function adHocSign(bundle) {
  if (process.env.CSC_NAME || process.env.CSC_LINK) return;
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle]);
  console.log(`  • ad-hoc signed  ${path.relative(process.cwd(), bundle)}`);
}
