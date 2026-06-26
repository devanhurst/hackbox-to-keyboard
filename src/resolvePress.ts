import type { Binding, ButtonDef, Layout, Players } from "./layouts";

// Pure key-resolution for the press path — no DOM, storage, or module state, so
// it is unit-testable and the host always presses its CURRENT truth.
//
// The host must resolve which key to press from its own live config at PRESS
// time, keyed by the stable button id the player's device echoes back. It must
// never trust a resolved key baked into the device at push time: a binding the
// host edits afterwards (a button's default, or a per-player override) would
// otherwise stay stale on the device until the next re-push, firing the old key.
// See README "How it works" and the h2k-keymap-k4 investigation.

/** The per-player override for a button, layered over the button's default. */
export function effectiveBinding(
  players: Players,
  userId: string,
  button: ButtonDef,
): Binding | null {
  return players[userId]?.overrides[button.id] ?? button.binding;
}

export interface ResolvedPress {
  /** The key to press now, or null if nothing should fire. */
  binding: Binding | null;
  /** The matched button (for the host's flash), or null if none matched. */
  button: ButtonDef | null;
}

/**
 * Resolve a player's tap to a keypress from current host config.
 *
 * @param wire the stable button id echoed back by the device (the Button's
 *   `event`). Returns nulls when the player has no assigned layout, the button
 *   no longer exists, or it has no binding.
 */
export function resolvePress(
  players: Players,
  layouts: Layout[],
  from: string,
  wire: string | undefined,
): ResolvedPress {
  const layoutId = players[from]?.layoutId ?? null;
  const layout = layoutId ? layouts.find((l) => l.id === layoutId) : undefined;
  const button = layout?.buttons.find((b) => b.id === wire) ?? null;
  return {
    binding: button ? effectiveBinding(players, from, button) : null,
    button,
  };
}
