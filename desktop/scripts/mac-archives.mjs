// Turns the packaged Saturn.app (electron-builder's "dir" target, with Saturn IDE inside) into the two downloads a
// release offers: a .dmg to drag into Applications and a .zip of the same app, each with a .sha256 beside it.
// ditto keeps the bundle's symlinks, permissions and ad-hoc signature intact; hdiutil writes an LZMA-compressed image
// (ULMO: about 30% smaller than the default zlib, readable on macOS 10.15 and later).
//
//   node scripts/mac-archives.mjs            (after electron-builder --mac --dir)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(desktop, "release");
const { version } = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const app = path.join(release, arch === "arm64" ? "mac-arm64" : "mac", "Saturn.app");
if (!existsSync(app)) {
  console.error(`No packaged app at ${app}; run electron-builder --mac first.`);
  process.exit(1);
}
const base = path.join(release, `Saturn-${version}-mac-${arch}-unsigned`);

function sha256(file) {
  const sum = createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(`${file}.sha256`, `${sum}  ${path.basename(file)}\n`);
  return sum;
}

// The zip: the app itself, as Finder would compress it.
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

for (const file of [`${base}.dmg`, `${base}.zip`]) {
  console.log(`  • ${path.basename(file)}  ${sha256(file)}`);
}
