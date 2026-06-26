# Modifier keys as button bindings — design

## Goal

Let the host bind a player button to a **standalone modifier key** — Left Shift,
Right Ctrl, Left Cmd, etc. — so a player's tap fires that modifier on the host's
keyboard. Mapping modifier **combos** to a single button (e.g. Ctrl+Shift) is out
of scope; the existing modifier-prefix combo feature (e.g. `Ctrl+C`) is preserved
unchanged.

Left vs. right must fire **distinct physical keys** where the platform supports
it (see Platform support).

## Why this is small

No data-model change. `Binding` is already `{ modifiers: Modifier[]; code: string }`
and `code` is a free-form string, so a standalone modifier is just
`{ modifiers: [], code: "ShiftLeft" }`. Persistence (`coerceBinding`),
encoding (`encodeBinding`), and the press path (`resolvePress`) already accept
any `code`. The work is in three places: the capture handler, the labels, and the
Rust keycode maps.

## Approach: tap-to-bind

The editor captures keys by listening for keydown while in capture mode. Today it
ignores modifier-only keydowns (`main.ts` `if (MODIFIER_CODES.has(e.code)) return;`)
and captures on the first **non**-modifier key, folding any held modifiers into
the binding. That combo behavior must stay: holding Ctrl and pressing C still
yields `Ctrl+C`.

To distinguish "I want to bind Shift itself" from "I'm holding Shift as a prefix",
bind a modifier on **keyup with nothing pressed in between**:

- **modifier keydown** → record it as the pending modifier (do not bind yet).
- **non-modifier keydown** → existing combo path; clear the pending modifier.
- **modifier keyup**, when it matches the pending modifier and no non-modifier
  key intervened → bind `{ modifiers: [], code }` using the W3C `e.code`
  (`ShiftLeft`, `ShiftRight`, `ControlLeft`, `ControlRight`, `AltLeft`,
  `AltRight`, `MetaLeft`, `MetaRight`).

In words: **tap a modifier by itself to bind it; hold a modifier and press a key
to make a combo.**

### Scope of the change in capture

This applies only to the **host-default** and **per-player-override** capture
kinds. The **player-input-key** capture (`capture.kind === "playerKey"`, the key
a player presses on their own hackbox device) is unaffected — OS modifiers are
meaningless there, so it keeps ignoring modifier keydowns exactly as today.

### Pure helper for testability

In keeping with the codebase's keep-logic-pure philosophy (`resolvePress.ts`),
extract the standalone-modifier decision into a small pure helper rather than
embedding it all in the DOM handler. Candidate:

```ts
// true when `code` is one of the eight bindable modifier codes
export function isModifierCode(code: string): boolean
// the binding produced by tapping a modifier by itself
export function standaloneModifierBinding(code: string): Binding  // { modifiers: [], code }
```

Placed alongside the other pure binding logic (e.g. in `layouts.ts` or a small
module) so `npm test` can guard it.

## Labels

`keyLabel` (`main.ts`) renders the eight codes as short, readable strings:

| code           | macOS     | Windows   |
| -------------- | --------- | --------- |
| `ShiftLeft`    | `L Shift` | `L Shift` |
| `ShiftRight`   | `R Shift` | `R Shift` |
| `ControlLeft`  | `L Ctrl`  | `L Ctrl`  |
| `ControlRight` | `R Ctrl`  | `R Ctrl`  |
| `AltLeft`      | `L Alt`   | `L Alt`   |
| `AltRight`     | `R Alt`   | `R Alt`   |
| `MetaLeft`     | `L Cmd`   | `L Win`   |
| `MetaRight`    | `R Cmd`   | `R Win`   |

(Cmd vs. Win chosen by platform; Alt left generic to avoid over-engineering.)

## Rust press path (`src-tauri/src/lib.rs`)

`code_to_key` resolves a `code` to an `enigo::Key`. Today it maps `ShiftLeft` and
`ShiftRight` both to the generic `Key::Shift` (and likewise Ctrl/Alt/Meta),
losing the side. The press function itself needs no change — it already presses
the resolved key with an empty modifier list.

### macOS — true L/R now (reliable)

Extend the existing `macos_virtual_keycode` map (which already drives letters and
digits via `Key::Other(vk)`) with the eight modifier virtual keycodes:

| code           | vk     |
| -------------- | ------ |
| `MetaLeft`     | `0x37` |
| `ShiftLeft`    | `0x38` |
| `AltLeft`      | `0x3A` |
| `ControlLeft`  | `0x3B` |
| `MetaRight`    | `0x36` |
| `ShiftRight`   | `0x3C` |
| `AltRight`     | `0x3D` |
| `ControlRight` | `0x3E` |

This is the user's platform and the values are from Apple's `Events.h`, so L/R is
delivered reliably here.

### Windows — attempt L/R, generic fallback guaranteed

Add an analogous `#[cfg(target_os = "windows")]` map to side-specific virtual-key
codes via `Key::Other` (`VK_LSHIFT`=0xA0, `VK_RSHIFT`=0xA1, `VK_LCONTROL`=0xA2,
`VK_RCONTROL`=0xA3, `VK_LMENU`=0xA4, `VK_RMENU`=0xA5, `VK_LWIN`=0x5B,
`VK_RWIN`=0x5C). If `Key::Other` on Windows does not distinguish sides, the
existing generic `Key::Shift`/`Control`/`Alt`/`Meta` arms remain as a working
fallback, so a Windows build never regresses to "unsupported key".

**Windows L/R is verify-on-build**, not a blocker for this change: it cannot be
tested from the macOS dev environment and is confirmed on a real Windows build in
a follow-up.

## Tests (`test/resolvePress.test.ts` + helper test)

- A modifier-code binding (`{ modifiers: [], code: "ControlRight" }`) round-trips
  through `resolvePress` and is returned for the matching button.
- `isModifierCode` is true for the eight codes and false for `KeyA`, `Space`, etc.
- `standaloneModifierBinding("MetaLeft")` yields `{ modifiers: [], code: "MetaLeft" }`.

(The DOM keydown/keyup state machine is exercised manually; the decision logic it
calls is covered by the pure-helper tests.)

## Docs

- README "Set keys" paragraph: note that tapping a modifier by itself binds that
  modifier (L/R distinct), while holding it + a key still makes a combo.
- CLAUDE.md: a sharp-edge note recording the macOS-reliable / Windows-verify split
  and the tap-vs-hold capture rule.

## Out of scope

- Modifier+modifier combos on one button (e.g. Ctrl+Shift as a single binding).
- Modifiers as **player-input** keys (the hackbox device side).
- Proving Windows L/R before merge.
