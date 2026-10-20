import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ideCandidates, ideLayout } from "../src/application/projects.js";

test("Saturn IDE's layout and likely locations follow the platform", () => {
  const win = ideLayout("win32");
  assert.deepEqual([win.bundle, win.binary, win.resources], ["Saturn IDE", ["Saturn IDE.exe"], ["resources", "app"]]);
  assert.match(win.buildDir, /^VSCode-win32-/);
  const mac = ideLayout("darwin");
  assert.deepEqual([mac.bundle, mac.binary, mac.resources], ["Saturn IDE.app", ["Contents", "MacOS", "Saturn IDE"], ["Contents", "Resources", "app"]]);
  const linux = ideLayout("linux");
  assert.deepEqual([linux.bundle, linux.binary[0]], ["Saturn IDE", "saturn-ide"]);

  const home = "C:\\Users\\rick";
  const repo = "C:\\src\\Saturn-App";
  const onWindows = ideCandidates("win32", home, repo, { LOCALAPPDATA: "C:\\Users\\rick\\AppData\\Local", ProgramFiles: "C:\\Program Files" });
  assert.equal(onWindows[0], path.join("C:\\Users\\rick\\AppData\\Local", "Programs", "Saturn IDE"), "the per-user install first");
  assert.equal(onWindows[1], path.join("C:\\Program Files", "Saturn IDE"));
  assert.ok(onWindows.some((item) => item.includes("VSCode-win32-")), "then a local build");

  const onMac = ideCandidates("darwin", "/Users/rick", "/Users/rick/src/Saturn-App");
  assert.deepEqual(onMac.slice(0, 2), ["/Applications/Saturn IDE.app", "/Users/rick/Applications/Saturn IDE.app"]);
  assert.ok(onMac[2]!.endsWith(path.join(`VSCode-darwin-${process.arch}`, "Saturn IDE.app")));
});
