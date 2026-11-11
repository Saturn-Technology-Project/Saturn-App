// The themes' colors: what must hold between them, whatever the palette.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

/** Every value a token is given, in the order the themes give it (light, then dark). */
const values = (name) => [...tokens.matchAll(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "gm"))].map((match) => match[1].trim());

test("the highlight under the pointer is a veil in both themes, so it shows on a dialog as on the window", () => {
  // The dark theme's was the solid color of dialogs and menus (--elevated): a row under the pointer there, in Settings'
  // list for one, looked like every other row.
  const hover = values("hover");
  const elevated = values("elevated");
  assert.equal(hover.length, 2);
  assert.equal(elevated.length, 2);
  for (const [index, value] of hover.entries()) {
    const alpha = /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*(0?\.\d+)\s*\)$/.exec(value)?.[1];
    assert.ok(alpha && Number(alpha) > 0 && Number(alpha) < 0.5, `--hover is ${value}`);
    assert.notEqual(value, elevated[index]);
  }
});
