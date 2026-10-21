import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ComputerUseSkill } from "../src/infrastructure/skills/computer-use-skill.js";
import { parseChord } from "../src/infrastructure/skills/windows.js";

test("Windows chords: cmd means Ctrl, named keys get virtual-key codes, letters keep their case only alone", () => {
  assert.deepEqual(parseChord("cmd+c"), { modifiers: [0x11], vk: 0, char: "c", extended: false });
  assert.deepEqual(parseChord("ctrl+shift+Escape"), { modifiers: [0x11, 0x10], vk: 0x1b, char: "", extended: false });
  assert.deepEqual(parseChord("win+Up"), { modifiers: [0x5b], vk: 0x26, char: "", extended: true });
  assert.deepEqual(parseChord("F5"), { modifiers: [], vk: 0x74, char: "", extended: false });
  assert.deepEqual(parseChord("A"), { modifiers: [], vk: 0, char: "A", extended: false });
  assert.throws(() => parseChord("hyper+x"), /Unknown modifier/);
  assert.throws(() => parseChord("ctrl+banana"), /Unknown key/);
});

type Shot = { image: string; scope: string; pid?: number; coordinate_token?: string; region: { width: number; height: number } };
type State = { snapshot_id: string; text: string };

/**
 * Drives Notepad for real: launch, screenshot, element tree, Unicode typing, a shortcut, a click. Needs an interactive
 * desktop: it runs on Windows when one is there (SATURN_TEST_DESKTOP=1 makes a missing desktop a failure, for CI).
 */
test("Windows computer use drives Notepad end to end", { skip: process.platform !== "win32" && "Windows only", timeout: 180_000 }, async (t) => {
  const skill = new ComputerUseSkill(await mkdtemp(path.join(os.tmpdir(), "saturn-cu-win-")));
  const status = (await skill.run("computer_check_permissions", {})) as { status: string; screenLocked: boolean };
  if (status.status !== "ready") {
    if (process.env.SATURN_TEST_DESKTOP === "1") assert.fail(`No usable desktop: ${JSON.stringify(status)}`);
    t.skip(`no interactive desktop (${status.status})`);
    return;
  }

  const apps = (await skill.run("computer_apps", {})) as { count: number };
  assert.equal(typeof apps.count, "number");

  const notepad = (await skill.run("computer_resolve_app", { app_name: "notepad" })) as { pid: number; target_id: string; name: string };
  const target = { scope: "app", pid: notepad.pid, target_id: notepad.target_id };
  try {
    const screen = (await skill.run("computer_screenshot", { target: { scope: "screen" } })) as Shot;
    assert.match(screen.image, /^data:image\/jpeg;base64,/);
    assert.ok(screen.image.length > 5000, "a real screen image");

    const shot = (await skill.run("computer_screenshot", { target })) as Shot;
    assert.equal(shot.scope, "app");
    assert.ok(shot.coordinate_token && shot.region.width > 100 && shot.region.height > 100, `window region ${JSON.stringify(shot.region)}`);

    const state = (await skill.run("computer_app_state", { target })) as State;
    const editor = state.text.split("\n").find((line) => /^\s*\[\d+\] (Document|Edit)\b.*settable/.test(line));
    assert.ok(editor, `Notepad's text area in the tree:\n${state.text.slice(0, 2000)}`);
    const elementId = Number(/\[(\d+)\]/.exec(editor!)![1]);

    await skill.run("computer_type", { target, text: "Hello Saturn 你好\nsecond line", element_id: elementId, snapshot_id: state.snapshot_id });
    let after = (await skill.run("computer_app_state", { target })) as State;
    assert.match(after.text, /Hello Saturn 你好/, "typed text, including Chinese, reached the editor");

    await skill.run("computer_key", { target, key: "ctrl+a" });
    await skill.run("computer_type", { target, text: "replaced" });
    after = (await skill.run("computer_app_state", { target })) as State;
    assert.match(after.text, /value="replaced"/, `Ctrl+A then typing replaced the text:\n${after.text.slice(0, 1500)}`);

    const click = (await skill.run("computer_click", { target, coordinate_token: shot.coordinate_token, x: 640, y: 400 })) as { success: boolean };
    assert.equal(click.success, true);
    const scrolled = (await skill.run("computer_scroll", { target, coordinate_token: shot.coordinate_token, x: 640, y: 400, direction: "down", amount: 2 })) as { success: boolean };
    assert.equal(scrolled.success, true);
  } finally {
    try {
      process.kill(notepad.pid);
    } catch {
      // Already gone.
    }
  }
});
