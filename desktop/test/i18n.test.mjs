// The interface's translations: every text given to `t()` has a Traditional Chinese translation with the
// same placeholders, every translation is used, and `t()` is only ever given a string literal.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { placeholders, resolveLocale, shortcutsOn, translate } from "../src/domain/i18n.ts";

const SOURCE = new URL("../src", import.meta.url).pathname;

/** Every .ts and .tsx file under the interface's source, but the translations themselves. */
function sources(folder = SOURCE) {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === "locales" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The literal texts given to `t()` in the source, and the places it is given something else. */
function calls() {
  const texts = new Map();
  const loose = [];
  for (const path of sources()) {
    const code = readFileSync(path, "utf8");
    for (const match of code.matchAll(/(?<![\w.$:?])t\(\s*/g)) {
      const rest = code.slice(match.index + match[0].length);
      const literal = /^(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)\s*[,)]/.exec(rest);
      const where = `${path.slice(SOURCE.length + 1)}:${code.slice(0, match.index).split("\n").length}`;
      if (!literal) {
        // The definition of `t` itself is not a call.
        if (!/^text: string/.test(rest)) loose.push(where);
        continue;
      }
      const [, double, single, template] = literal;
      const raw = double ?? (single ?? template).replace(/\\(['`])/g, "$1").replace(/(?<!\\)"/g, '\\"');
      const text = JSON.parse(`"${raw}"`);
      texts.set(text, texts.get(text) ?? where);
    }
  }
  return { texts, loose };
}

// Every dictionary file, read directly: the index's imports are written for the bundler.
const LOCALES = new URL("../src/locales/zh-Hant/", import.meta.url);
const ENGLISH = new URL("../src/locales/en/", import.meta.url);
const load = (folder) => Promise.all(readdirSync(folder).sort().map(async (name) => (await import(new URL(name, folder).href)).default));
const traditionalChinese = await load(LOCALES);
const english = await load(ENGLISH);
const merged = Object.assign({}, ...traditionalChinese);

test("the index merges every dictionary file", () => {
  const index = readFileSync(new URL("../src/locales/index.ts", import.meta.url), "utf8");
  for (const name of readdirSync(LOCALES)) assert.match(index, new RegExp(`from "./zh-Hant/${name.replace(/\.ts$/, "")}"`));
  for (const name of readdirSync(ENGLISH)) assert.match(index, new RegExp(`from "./en/${name.replace(/\.ts$/, "")}"`));
});

test("English wording replaces only texts the code uses, keeps their placeholders, and words each one way", () => {
  const { texts } = calls();
  const seen = new Map();
  const problems = [];
  for (const dictionary of english) {
    for (const [text, worded] of Object.entries(dictionary)) {
      if (!texts.has(text)) problems.push(`unused: ${text}`);
      if (placeholders(text).join() !== placeholders(worded).join()) problems.push(`placeholders: ${text}`);
      if (seen.has(text) && seen.get(text) !== worded) problems.push(`two ways: ${text}`);
      seen.set(text, worded);
    }
  }
  assert.deepEqual(problems, []);
});

test("t() is only given string literals", () => {
  assert.deepEqual(calls().loose, []);
});

test("every text given to t() has a Traditional Chinese translation", () => {
  const missing = [...calls().texts].filter(([text]) => !Object.hasOwn(merged, text)).map(([text, where]) => `${where}  ${text}`);
  assert.deepEqual(missing, []);
});

test("translations keep the English text's placeholders", () => {
  const changed = Object.entries(merged).filter(([text, translated]) => placeholders(text).join() !== placeholders(translated).join());
  assert.deepEqual(changed, []);
});

test("every translation is used, and one text is translated one way", () => {
  const { texts } = calls();
  assert.deepEqual(Object.keys(merged).filter((text) => !texts.has(text)), []);
  const seen = new Map();
  const different = [];
  for (const dictionary of traditionalChinese) {
    for (const [text, translated] of Object.entries(dictionary)) {
      if (seen.has(text) && seen.get(text) !== translated) different.push(text);
      seen.set(text, translated);
    }
  }
  assert.deepEqual(different, []);
});

test("the system's language picks Traditional Chinese only for Traditional Chinese readers", () => {
  assert.equal(resolveLocale("auto", ["zh-TW", "en-US"]), "zh-Hant");
  assert.equal(resolveLocale("auto", ["zh-Hant-HK"]), "zh-Hant");
  assert.equal(resolveLocale("auto", ["zh-CN"]), "en");
  assert.equal(resolveLocale("auto", ["zh-Hans-TW"]), "en");
  assert.equal(resolveLocale("auto", ["fr-FR", "zh-TW"]), "zh-Hant");
  assert.equal(resolveLocale("auto", ["en-GB", "zh-TW"]), "en");
  assert.equal(resolveLocale("auto", []), "en");
  assert.equal(resolveLocale("en", ["zh-TW"]), "en");
  assert.equal(resolveLocale("zh-Hant", ["en-US"]), "zh-Hant");
});

test("a missing translation shows the English, and placeholders are filled either way", () => {
  assert.equal(translate({}, "{count} runs", { count: 3 }), "3 runs");
  assert.equal(translate({ "{count} runs": "{count} 次執行" }, "{count} runs", { count: 3 }), "3 次執行");
  assert.equal(translate({}, "Keeps {name}"), "Keeps {name}");
});

test("shortcuts read with Ctrl on a system that is not a Mac, and stay as written on one", () => {
  // Up to 0.6.1 Windows showed the Mac's sign, "Commands ⌘K", for keys pressed with Ctrl.
  for (const [written, elsewhere] of [
    ["⌘K", "Ctrl+K"],
    ["⌘ K", "Ctrl+K"],
    ["⌘,", "Ctrl+,"],
    ["⌘ 1 to 7", "Ctrl+1 to 7"],
    ["⌘↵", "Ctrl+Enter"],
    ["Open every command here, or with ⌘K.", "Open every command here, or with Ctrl+K."],
    ["每個畫面旁都有這個面板（⌘J）。", "每個畫面旁都有這個面板（Ctrl+J）。"],
    ["Shift + Enter", "Shift + Enter"],
  ]) {
    assert.equal(shortcutsOn(true, written), written);
    assert.equal(shortcutsOn(false, written), elsewhere);
  }
  const dictionary = { "{shortcut} to save": "按 {shortcut} 儲存", "Show it with ⌘J.": "按 ⌘J 顯示。" };
  assert.equal(translate(dictionary, "Show it with ⌘J.", undefined, false), "按 Ctrl+J 顯示。");
  assert.equal(translate(dictionary, "Show it with ⌘J."), "按 ⌘J 顯示。");
  // Only the text's own shortcuts change, never what is put into it.
  assert.equal(translate(dictionary, "{shortcut} to save", { shortcut: "⌘S" }, false), "按 ⌘S 儲存");
});
