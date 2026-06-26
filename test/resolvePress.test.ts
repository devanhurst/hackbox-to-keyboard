import { test } from "node:test";
import assert from "node:assert/strict";
// Explicit .ts extension: run with Node's native type stripping (`node --test`).
// resolvePress.ts has no runtime imports (only `import type`), so this pulls in
// no DOM/Tauri/storage code.
import { resolvePress } from "../src/resolvePress.ts";
import type { Binding, Layout, Players } from "../src/layouts.ts";

const KeyA: Binding = { code: "KeyA", modifiers: [] };
const KeyB: Binding = { code: "KeyB", modifiers: [] };
const KeyZ: Binding = { code: "KeyZ", modifiers: [] };

function layout(buttonBinding: Binding | null): Layout {
  return {
    id: "L1",
    name: "Quiz",
    buttons: [
      { id: "btn-A", label: "Answer", color: "#fff", binding: buttonBinding, playerKey: null },
    ],
  };
}

const PLAYER = "player-stable-id-123";

// The host echoes the button's stable id; the press path keys off that id.
const WIRE = "btn-A";

test("resolves a player's tap to the button's current default binding", () => {
  const players: Players = { [PLAYER]: { layoutId: "L1", overrides: {}, enabled: true } };
  const { binding, button } = resolvePress(players, [layout(KeyA)], PLAYER, WIRE);
  assert.deepEqual(binding, KeyA);
  assert.equal(button?.id, "btn-A");
});

test("REGRESSION: editing the default key changes the press immediately, no re-push", () => {
  const players: Players = { [PLAYER]: { layoutId: "L1", overrides: {}, enabled: true } };
  const layouts = [layout(KeyA)];

  // First the button fires KeyA.
  assert.deepEqual(resolvePress(players, layouts, PLAYER, WIRE).binding, KeyA);

  // Host edits the button's default key to KeyB (mutates config in place, the
  // way the editor capture does) — and pushes NOTHING to the device.
  layouts[0].buttons[0].binding = KeyB;

  // The very next tap must already press KeyB, not the stale KeyA.
  assert.deepEqual(resolvePress(players, layouts, PLAYER, WIRE).binding, KeyB);
});

test("REGRESSION: setting a per-player override changes the press immediately, no re-push", () => {
  const players: Players = { [PLAYER]: { layoutId: "L1", overrides: {}, enabled: true } };
  const layouts = [layout(KeyA)];

  // Host sets a per-player override to KeyZ (no re-push).
  players[PLAYER].overrides["btn-A"] = KeyZ;
  assert.deepEqual(resolvePress(players, layouts, PLAYER, WIRE).binding, KeyZ);

  // Clearing the override falls straight back to the layout default — immediately.
  delete players[PLAYER].overrides["btn-A"];
  assert.deepEqual(resolvePress(players, layouts, PLAYER, WIRE).binding, KeyA);
});

test("two players on the same layout resolve independently by their own config", () => {
  const P2 = "player-2";
  const players: Players = {
    [PLAYER]: { layoutId: "L1", overrides: {}, enabled: true },
    [P2]: { layoutId: "L1", overrides: { "btn-A": KeyZ }, enabled: true },
  };
  const layouts = [layout(KeyA)];
  assert.deepEqual(resolvePress(players, layouts, PLAYER, WIRE).binding, KeyA);
  assert.deepEqual(resolvePress(players, layouts, P2, WIRE).binding, KeyZ);
});

test("resolves a standalone modifier binding for the matching button", () => {
  const lShift: Binding = { code: "ShiftLeft", modifiers: [] };
  const players: Players = { [PLAYER]: { layoutId: "L1", overrides: {}, enabled: true } };
  const { binding, button } = resolvePress(players, [layout(lShift)], PLAYER, WIRE);
  assert.deepEqual(binding, lShift);
  assert.equal(button?.id, "btn-A");
});

test("no binding / no layout / unknown button resolve to no press", () => {
  const players: Players = {
    a: { layoutId: "L1", overrides: {}, enabled: true },
    b: { layoutId: null, overrides: {}, enabled: true },
  };
  const layouts = [layout(null)];
  assert.equal(resolvePress(players, layouts, "a", WIRE).binding, null); // button has no key
  assert.equal(resolvePress(players, layouts, "b", WIRE).binding, null); // no layout
  assert.equal(resolvePress(players, layouts, "a", "ghost").button, null); // unknown id
  assert.equal(resolvePress(players, layouts, "unknown", WIRE).binding, null); // unknown player
});
