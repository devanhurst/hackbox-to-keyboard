// ---------------------------------------------------------------------------
// Layouts & per-player config.
//
// A *layout* is a named set of buttons. Each button has a label (what the
// player sees), a colour, and an optional *default* key binding. Baking keys
// into a layout makes it self-contained and shareable: e.g. "Duel Player 1" and
// "Duel Player 2" are two six-button layouts with consistent, different keymaps.
//
// A *player config* (keyed by userId) records which layout, if any, a player is
// assigned, plus any per-player *overrides* of a button's default key. Effective
// key = override ?? button default. Players start with NO config — they see
// nothing until the host assigns them a layout, and different players can be on
// different layouts.
//
// Layouts can be exported/imported as JSON to share with friends (keys
// included). Player config is never exported (it's tied to specific userIds on
// this machine).
// ---------------------------------------------------------------------------

import { storage } from "./storage";

export type Modifier = "Control" | "Alt" | "Shift" | "Meta";

// A binding is a main key (KeyboardEvent.code, e.g. "KeyA") plus zero or more
// modifiers held down around it.
export interface Binding {
  modifiers: Modifier[];
  code: string;
}

export interface ButtonDef {
  id: string; // stable id within the layout; used as the button's event name
  label: string; // text shown on the player's button
  color: string; // button background colour
  binding: Binding | null; // default host key injected on tap (overridable per-player)
  // Key the PLAYER presses on their own device to trigger this button, as a
  // KeyboardEvent.key value (e.g. " " for space). Shared by all players on the
  // layout. null = tap only. Distinct from `binding`, the key pressed on the
  // host machine.
  playerKey: string | null;
}

export interface Layout {
  id: string;
  name: string;
  buttons: ButtonDef[];
}

// A player's assignment: which layout they're on (null = none) plus any
// per-player overrides of a button's default key, keyed by buttonId.
export interface PlayerConfig {
  layoutId: string | null;
  overrides: Record<string, Binding>;
}

// userId -> PlayerConfig.
export type Players = Record<string, PlayerConfig>;

export const MODIFIER_ORDER: Modifier[] = ["Control", "Alt", "Shift", "Meta"];

const LS = {
  layouts: "h2k.layouts",
  editingLayoutId: "h2k.editingLayoutId",
  players: "h2k.players",
  legacyBindings: "h2k.bindings", // original single-button shape: userId -> Binding
} as const;

const DEFAULT_COLOR = "#7c5cff";

const uid = () => crypto.randomUUID();

export function newButton(label = "Button", color = DEFAULT_COLOR): ButtonDef {
  return { id: uid(), label, color, binding: null, playerKey: null };
}

// Clone a layout into an independent copy: fresh layout id and fresh button ids
// (so per-player overrides, which are keyed by buttonId, never bleed between the
// original and the copy). Default keys, labels, and colours are preserved.
export function duplicateLayout(layout: Layout, name: string): Layout {
  return {
    id: uid(),
    name,
    buttons: layout.buttons.map((b) => ({
      id: uid(),
      label: b.label,
      color: b.color,
      binding: b.binding ? { ...b.binding, modifiers: [...b.binding.modifiers] } : null,
      playerKey: b.playerKey,
    })),
  };
}

function defaultLayout(): Layout {
  // Ships with the app as a ready-to-use starting point: a single red BUZZ
  // button the player fires with the spacebar (" " is the KeyboardEvent.key for
  // Space), with no host key bound by default.
  return {
    id: uid(),
    name: "Buzzer",
    buttons: [{ id: uid(), label: "BUZZ", color: "#ef4444", binding: null, playerKey: " " }],
  };
}

// --- wire encoding --------------------------------------------------------

// The host pushes each button's *resolved* key (its per-player override, else
// the layout default) to the player as the Button's `value`. The player echoes
// that value back untouched on tap, so the value IS the keypress: the host
// presses whatever comes back, with no button lookup and no shared identity on
// the wire. Two buttons that resolve to the same key legitimately send the same
// value — that's fine, the host presses the same key either way.
//
// Format: modifiers (canonical order) then the KeyboardEvent.code, joined by
// "+", e.g. "Control+Shift+KeyA" or just "KeyA". A tap-only button (no host
// key) encodes to "" and fires nothing. No KeyboardEvent.code contains "+", so
// the round-trip split is unambiguous.
export function encodeBinding(b: Binding | null): string {
  if (!b) return "";
  return [...MODIFIER_ORDER.filter((m) => b.modifiers.includes(m)), b.code].join("+");
}

export function decodeBinding(s: unknown): Binding | null {
  if (typeof s !== "string" || !s) return null;
  const parts = s.split("+");
  const code = parts.pop();
  if (!code) return null;
  return { code, modifiers: MODIFIER_ORDER.filter((m) => parts.includes(m)) };
}

// --- validation -----------------------------------------------------------

function coerceModifiers(v: unknown): Modifier[] {
  if (!Array.isArray(v)) return [];
  return MODIFIER_ORDER.filter((m) => v.includes(m));
}

function coerceBinding(v: unknown): Binding | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if (typeof b.code !== "string" || !b.code) return null;
  return { code: b.code, modifiers: coerceModifiers(b.modifiers) };
}

function coerceButton(v: unknown): ButtonDef | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  return {
    id: typeof b.id === "string" && b.id ? b.id : uid(),
    label: typeof b.label === "string" ? b.label : "Button",
    color: typeof b.color === "string" && b.color ? b.color : DEFAULT_COLOR,
    binding: coerceBinding(b.binding),
    playerKey: typeof b.playerKey === "string" && b.playerKey ? b.playerKey : null,
  };
}

function coerceLayout(v: unknown): Layout | null {
  if (!v || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  const buttons = Array.isArray(l.buttons)
    ? (l.buttons.map(coerceButton).filter(Boolean) as ButtonDef[])
    : [];
  return {
    id: typeof l.id === "string" && l.id ? l.id : uid(),
    name: typeof l.name === "string" && l.name ? l.name : "Layout",
    buttons,
  };
}

// --- persistence ----------------------------------------------------------

export function loadLayouts(): Layout[] {
  const stored = storage.getItem(LS.layouts);
  if (stored !== null) {
    // The key exists — respect whatever's there, including an empty list (the
    // user may have deleted every layout).
    try {
      const raw = JSON.parse(stored);
      if (Array.isArray(raw)) return raw.map(coerceLayout).filter(Boolean) as Layout[];
    } catch {
      /* corrupt — fall through to seed */
    }
  }

  // First run: seed a starter layout and migrate any legacy single-button
  // bindings into per-player config assigned to it.
  const layout = defaultLayout();
  migrateLegacyBindings(layout.id, layout.buttons[0].id);
  saveLayouts([layout]);
  return [layout];
}

export function saveLayouts(layouts: Layout[]) {
  storage.setItem(LS.layouts, JSON.stringify(layouts));
}

export function getEditingLayoutId(): string | null {
  return storage.getItem(LS.editingLayoutId);
}

export function setEditingLayoutId(id: string) {
  storage.setItem(LS.editingLayoutId, id);
}

export function loadPlayers(): Players {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(storage.getItem(LS.players) || "{}");
  } catch {
    return {};
  }
  const out: Players = {};
  for (const [userId, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    const overrides: Record<string, Binding> = {};
    if (c.overrides && typeof c.overrides === "object") {
      for (const [buttonId, b] of Object.entries(c.overrides as Record<string, unknown>)) {
        const binding = coerceBinding(b);
        if (binding) overrides[buttonId] = binding;
      }
    }
    out[userId] = {
      layoutId: typeof c.layoutId === "string" ? c.layoutId : null,
      overrides,
    };
  }
  return out;
}

export function savePlayers(players: Players) {
  storage.setItem(LS.players, JSON.stringify(players));
}

// Migrate the original `userId -> Binding` store (a single "press" button) into
// per-player config assigned to the seeded layout, with the old key kept as a
// per-player override.
function migrateLegacyBindings(layoutId: string, buttonId: string) {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(storage.getItem(LS.legacyBindings) || "{}");
  } catch {
    return;
  }
  const players: Players = {};
  for (const [userId, v] of Object.entries(raw)) {
    // Old shapes: plain "KeyA" string, or { modifiers, code }.
    const binding =
      typeof v === "string" ? { code: v, modifiers: [] as Modifier[] } : coerceBinding(v);
    if (binding) players[userId] = { layoutId, overrides: { [buttonId]: binding } };
  }
  if (Object.keys(players).length) savePlayers(players);
  storage.removeItem(LS.legacyBindings);
}

// --- export / import ------------------------------------------------------

const EXPORT_TYPE = "hackbox-keyboard-layout";
const EXPORT_VERSION = 1;

// Serialize a layout (buttons + labels + colours + default keys) for sharing.
// Per-player config is never involved.
export function exportLayout(layout: Layout): string {
  return JSON.stringify(
    { type: EXPORT_TYPE, version: EXPORT_VERSION, layout },
    null,
    2,
  );
}

// Parse a shared layout. Accepts both the wrapped export envelope and a bare
// layout object. Returns a layout with a fresh id so it never clobbers an
// existing one. Throws on anything unrecognizable.
export function importLayout(json: string): Layout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Not valid JSON");
  }

  const obj = parsed as Record<string, unknown> | null;
  const candidate =
    obj && obj.type === EXPORT_TYPE && obj.layout ? obj.layout : parsed;

  const layout = coerceLayout(candidate);
  if (!layout || !layout.buttons.length) {
    throw new Error("No buttons found in this layout");
  }
  layout.id = uid(); // avoid colliding with an existing layout
  return layout;
}
