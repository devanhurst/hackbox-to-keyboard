import type { Binding } from "./layouts";

// Pure modifier-key logic for the capture path — no DOM, storage, or module
// state, so it is unit-testable (test/modifierKeys.test.ts via `node --test`),
// same discipline as resolvePress.ts.
//
// A button can be bound to a standalone modifier key (Left Shift, Right Ctrl,
// Left Cmd, …). The W3C `KeyboardEvent.code` of a modifier IS the binding code,
// so a tap of Left Shift binds `{ modifiers: [], code: "ShiftLeft" }`. Left vs.
// right are distinct codes here; honoring them as distinct physical keys is the
// Rust press path's job (true L/R on macOS; verify-on-build on Windows).

/** The eight modifier `KeyboardEvent.code` values a button can be bound to. */
export const MODIFIER_CODES: ReadonlySet<string> = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** The binding produced by tapping a modifier by itself: the modifier alone. */
export function standaloneModifierBinding(code: string): Binding {
  return { modifiers: [], code };
}
