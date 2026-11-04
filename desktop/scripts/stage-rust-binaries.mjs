// Builds the Rust runtime and the saturn command for release and puts them where the Tauri bundle takes its programs from, named
// with this computer's target as Tauri expects. Packaged, they sit next to the app's own program, and so next to each other, which
// the launcher `saturn` installs relies on.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(desktop, "..");
const target = /^host: (.+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!target) throw new Error("rustc did not say which target this computer is");

execFileSync("cargo", ["build", "--release", "-p", "saturn-server", "-p", "saturn-cli"], { cwd: repository, stdio: "inherit" });

const extension = process.platform === "win32" ? ".exe" : "";
const staged = path.join(desktop, "src-tauri", "binaries");
mkdirSync(staged, { recursive: true });
for (const name of ["saturn-server", "saturn"]) {
  copyFileSync(path.join(repository, "target", "release", `${name}${extension}`), path.join(staged, `${name}-${target}${extension}`));
}
