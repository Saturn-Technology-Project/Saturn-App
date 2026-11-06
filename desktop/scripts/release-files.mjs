// Turns what `npm run package` built into the downloads a release offers, in desktop/release, each with a .sha256 beside it. On
// macOS a .dmg to drag into Applications and a .zip of the same app; on Windows the installer. ditto keeps the bundle's permissions
// and ad-hoc signature intact; hdiutil writes an LZMA-compressed image (ULMO: about 30% smaller than the default zlib). When the build
// made updater packages, they and latest.json's entry for this system come along.
//
//   node scripts/release-files.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundles = path.join(desktop, "..", "target", "release", "bundle");
const release = path.join(desktop, "release");
const { version } = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
mkdirSync(release, { recursive: true });

function sha256(file) {
  const sum = createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(`${file}.sha256`, `${sum}  ${path.basename(file)}\n`);
  console.log(`  • ${path.basename(file)}  ${sum}`);
}

/** Copies an updater package and its signature under `name`, and records it for latest.json. */
function updaterPackage(source, name, platform) {
  if (!existsSync(`${source}.sig`)) return;
  copyFileSync(source, path.join(release, name));
  sha256(path.join(release, name));
  writeFileSync(path.join(release, `updater-${platform}.json`), JSON.stringify({
    platform,
    signature: readFileSync(`${source}.sig`, "utf8").trim(),
    url: `https://github.com/Saturn-Technology-Project/Saturn-App/releases/download/v${version}/${name}`,
  }));
}

if (process.platform === "darwin") {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const app = path.join(bundles, "macos", "Saturn.app");
  if (!existsSync(app)) throw new Error(`No packaged app at ${app}; run npm run package first.`);
  const base = path.join(release, `Saturn-${version}-mac-${arch}-unsigned`);
  rmSync(`${base}.zip`, { force: true });
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, `${base}.zip`], { stdio: "inherit" });
  // The disk image: the app next to an Applications link, so installing is one drag.
  const staging = mkdtempSync(path.join(os.tmpdir(), "saturn-dmg-"));
  try {
    execFileSync("ditto", [app, path.join(staging, "Saturn.app")]);
    symlinkSync("/Applications", path.join(staging, "Applications"));
    rmSync(`${base}.dmg`, { force: true });
    execFileSync("hdiutil", ["create", "-volname", "Saturn", "-srcfolder", staging, "-ov", "-format", "ULMO", "-fs", "HFS+", `${base}.dmg`], { stdio: "inherit" });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  sha256(`${base}.dmg`);
  sha256(`${base}.zip`);
  updaterPackage(path.join(bundles, "macos", "Saturn.app.tar.gz"), `Saturn-${version}-mac-${arch}-update.tar.gz`, `darwin-${arch === "arm64" ? "aarch64" : "x86_64"}`);
} else if (process.platform === "win32") {
  const folder = path.join(bundles, "nsis");
  const installer = readdirSync(folder).find((name) => name.endsWith("-setup.exe"));
  if (!installer) throw new Error(`No installer in ${folder}; run npm run package first.`);
  const target = path.join(release, `Saturn-${version}-win-x64-setup.exe`);
  copyFileSync(path.join(folder, installer), target);
  sha256(target);
  if (existsSync(path.join(folder, `${installer}.sig`))) {
    writeFileSync(path.join(release, "updater-windows-x86_64.json"), JSON.stringify({
      platform: "windows-x86_64",
      signature: readFileSync(path.join(folder, `${installer}.sig`), "utf8").trim(),
      url: `https://github.com/Saturn-Technology-Project/Saturn-App/releases/download/v${version}/${path.basename(target)}`,
    }));
  }
} else {
  throw new Error(`Saturn is released for macOS and Windows, not ${process.platform}`);
}
