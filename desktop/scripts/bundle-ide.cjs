// electron-builder afterPack hook: puts Saturn IDE.app (the Code-OSS fork in ../Saturn-IDE) inside
// Saturn.app/Contents/Resources, so "Open IDE" works without a separate install.
// ditto keeps the IDE bundle's framework symlinks and permissions, which extraResources does not.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ARCHES = { 1: "x64", 3: "arm64" };

exports.default = async function bundleIde(context) {
  if (context.electronPlatformName !== "darwin") return;
  const arch = ARCHES[context.arch] ?? "arm64";
  const source =
    process.env.SATURN_IDE_BUILD ||
    path.resolve(__dirname, "..", "..", `VSCode-darwin-${arch}`, "Saturn IDE.app");
  if (!fs.existsSync(source)) {
    if (process.env.SATURN_SKIP_IDE === "1") {
      console.warn(`  • Saturn IDE not bundled: ${source} is missing (SATURN_SKIP_IDE=1)`);
      adHocSign(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
      return;
    }
    throw new Error(
      `Saturn IDE build not found at ${source}. Run "npm run build:ide" first, or set SATURN_SKIP_IDE=1 to package without it.`,
    );
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const target = path.join(app, "Contents", "Resources", "Saturn IDE.app");
  fs.rmSync(target, { recursive: true, force: true });
  execFileSync("ditto", [source, target]);
  console.log(`  • bundled Saturn IDE  ${path.relative(process.cwd(), target)}`);
  adHocSign(target);
  adHocSign(app);
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
