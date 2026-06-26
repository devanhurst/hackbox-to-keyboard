import { test } from "node:test";
import assert from "node:assert/strict";
// Explicit .ts extension: run with Node's native type stripping (`node --test`).
// modifierKeys.ts has no runtime imports (only `import type`), so this pulls in
// no DOM/Tauri/storage code — same discipline as resolvePress.ts.
import {
  MODIFIER_CODES,
  isModifierCode,
  standaloneModifierBinding,
} from "../src/modifierKeys.ts";

test("isModifierCode is true for the eight bindable modifier codes", () => {
  for (const code of [
    "ShiftLeft",
    "ShiftRight",
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
    "MetaLeft",
    "MetaRight",
  ]) {
    assert.equal(isModifierCode(code), true, code);
  }
  assert.equal(MODIFIER_CODES.size, 8);
});

test("isModifierCode is false for non-modifier codes", () => {
  for (const code of ["KeyA", "Space", "Digit1", "Enter", "F1", ""]) {
    assert.equal(isModifierCode(code), false, code);
  }
});

test("standaloneModifierBinding yields the modifier as code with no modifiers", () => {
  assert.deepEqual(standaloneModifierBinding("MetaLeft"), {
    modifiers: [],
    code: "MetaLeft",
  });
  assert.deepEqual(standaloneModifierBinding("ControlRight"), {
    modifiers: [],
    code: "ControlRight",
  });
});
