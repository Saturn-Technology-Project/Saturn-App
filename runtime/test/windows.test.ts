import assert from "node:assert/strict";
import test from "node:test";
import { isSensitiveOperation } from "../src/domain/policies.js";
import { commandEnv, shellInvocation, terminalEnv } from "../src/infrastructure/shell.js";

test("Windows destructive commands need approval", () => {
  for (const command of [
    "del /s /q C:\\work\\build",
    "DEL /Q *.log",
    "erase /s old",
    "rd /s /q node_modules",
    "rmdir /S dist",
    "Remove-Item -Recurse -Force .\\out",
    "ri .\\out -r",
    "rm dist -Recurse",
    "format D:",
    "Format-Volume -DriveLetter D",
    "diskpart /s wipe.txt",
    "Clear-Disk -Number 1 -RemoveData",
    "reg delete HKCU\\Software\\Saturn /f",
    "reg.exe add HKLM\\Software\\X /v Y /d 1",
    "Remove-Item HKCU:\\Software\\Saturn",
    "Stop-Process -Name node -Force",
    "taskkill /f /im node.exe",
    "shutdown /s /t 0",
    "vssadmin delete shadows /all",
    "Set-ExecutionPolicy Unrestricted",
    "Start-Process powershell -Verb RunAs",
  ]) {
    assert.equal(isSensitiveOperation("code", { command }), true, command);
  }
});

test("everyday Windows commands run without approval", () => {
  for (const command of [
    "dir /s",
    "del notes.txt",
    "Remove-Item notes.txt",
    "Get-ChildItem -Recurse",
    "git status",
    "node --version",
    "python -m pytest",
    "reg query HKCU\\Software",
    "echo \"hello world\"",
  ]) {
    assert.equal(isSensitiveOperation("code", { command }), false, command);
  }
});

test("Unix rules are unchanged", () => {
  assert.equal(isSensitiveOperation("code", { command: "rm -rf build" }), true);
  assert.equal(isSensitiveOperation("code", { command: "sudo ls" }), true);
  assert.equal(isSensitiveOperation("code", { command: "ls -la" }), false);
});

test("file paths outside the workspace include Windows absolute paths", () => {
  assert.equal(isSensitiveOperation("files", { action: "write", path: "C:\\Windows\\win.ini" }), true);
  assert.equal(isSensitiveOperation("files", { action: "write", path: "c:/temp/x" }), true);
  assert.equal(isSensitiveOperation("files", { action: "write", path: "\\\\server\\share\\x" }), true);
  assert.equal(isSensitiveOperation("files", { action: "write", path: "notes/a.md" }), false);
});

test("on Windows the code tool runs cmd the way Node's shell option does", () => {
  const env = { ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const call = shellInvocation('echo "a b" && node -e "console.log(1)"', "/bin/sh", "win32", env);
  assert.equal(call.file, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(call.args, ["/d", "/s", "/c", '"echo "a b" && node -e "console.log(1)""']);
  assert.equal(call.windowsVerbatimArguments, true);
  assert.equal(shellInvocation("dir", "/bin/sh", "win32", {}).file, "cmd.exe");
});

test("on macOS the code tool still runs /bin/sh -c", () => {
  assert.deepEqual(shellInvocation("ls", "/bin/sh", "darwin"), { file: "/bin/sh", args: ["-c", "ls"], windowsVerbatimArguments: false });
});

test("on Windows commands get the variables programs need, and nothing else", () => {
  const env = commandEnv("win32", {
    Path: "C:\\Windows\\system32",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    USERPROFILE: "C:\\Users\\a",
    APPDATA: "C:\\Users\\a\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    OPENAI_API_KEY: "secret",
  });
  assert.equal(env.Path, "C:\\Windows\\system32");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env["ProgramFiles(x86)"], "C:\\Program Files (x86)");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(Object.keys(env).length, 11);
});

test("on macOS commands still get only PATH", () => {
  assert.deepEqual(commandEnv("darwin", { PATH: "/usr/bin", HOME: "/Users/a", SECRET: "x" }), { PATH: "/usr/bin" });
  assert.deepEqual(commandEnv("darwin", {}), { PATH: "/usr/bin:/bin" });
});

test("the Terminal panel adds Homebrew folders on macOS only", () => {
  assert.equal(
    terminalEnv({ PATH: "/usr/bin" }, "darwin").PATH,
    "/usr/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
  const windows = terminalEnv({ Path: "C:\\Windows;C:\\Git\\cmd" }, "win32");
  assert.equal(windows.Path, "C:\\Windows;C:\\Git\\cmd");
  assert.equal(windows.PATH, undefined);
  assert.equal(windows.TERM, "xterm-256color");
});
