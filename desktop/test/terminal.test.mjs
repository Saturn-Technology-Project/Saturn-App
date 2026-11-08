// Command history follows a terminal's up/down keys, preserving the command still being typed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyHistory, navigateHistory, rememberCommand } from "../src/domain/terminal.ts";

test("history returns earlier commands and restores the unfinished line on the way down", () => {
  let history = rememberCommand(rememberCommand(emptyHistory(), "pwd"), "ls src");
  let moved = navigateHistory(history, "up", "python unfinished");
  assert.equal(moved.command, "ls src");
  moved = navigateHistory(moved.history, "up", moved.command);
  assert.equal(moved.command, "pwd");
  moved = navigateHistory(moved.history, "up", moved.command);
  assert.equal(moved.command, "pwd");
  moved = navigateHistory(moved.history, "down", moved.command);
  assert.equal(moved.command, "ls src");
  moved = navigateHistory(moved.history, "down", moved.command);
  assert.equal(moved.command, "python unfinished");
  assert.equal(navigateHistory(moved.history, "down", moved.command).command, "python unfinished");
});

test("empty history leaves typing alone and remembered commands have bounded consecutive duplicates", () => {
  assert.equal(navigateHistory(emptyHistory(), "up", "draft").command, "draft");
  let history = rememberCommand(emptyHistory(), "pwd");
  history = rememberCommand(history, "pwd");
  assert.deepEqual(history.entries, ["pwd"]);
  for (let i = 0; i < 250; i++) history = rememberCommand(history, `echo ${i}`);
  assert.equal(history.entries.length, 200);
  assert.equal(navigateHistory(history, "up", "").command, "echo 249");
});
