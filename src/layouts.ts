// ---------------------------------------------------------------------------
// Layouts: the host's customizable button configurations.
//
// A *layout* is a named set of buttons. Each button has a label (what the
// player sees) and an optional *default* key binding. Bindings can be
// overridden per-player (see PlayerBindings) so the same layout can drive
// different keys for each player — e.g. in a duel, both players see the same
// six buttons but each player's "accelerate" maps to a different key.
//
// Layouts are persisted in localStorage and can be exported/imported as JSON
// to share with friends. Per-player overrides are NOT exported (they're tied
// to specific userIds and only meaningful on this machine).
// ---------------------------------------------------------------------------

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
  binding: Binding | null; // default key for this button (may be overridden per-player)
}

export interface Layout {
  id: string;
  name: string;
  buttons: ButtonDef[];
}

// userId -> (buttonId -> Binding). A per-player override of a button's default.
export type PlayerBindings = Record<string, Record<string, Binding>>;

export const MODIFIER_ORDER: Modifier[] = ["Control", "Alt", "Shift", "Meta"];

const LS = {
  layouts: "h2k.layouts",
  activeLayoutId: "h2k.activeLayoutId",
  playerBindings: "h2k.playerBindings",
  legacyBindings: "h2k.bindings", // old single-button shape: userId -> Binding
} as const;

const DEFAULT_COLOR = "#7c5cff";

const uid = () => crypto.randomUUID();

export function newButton(label = "Button", color = DEFAULT_COLOR): ButtonDef {
  return { id: uid(), label, color, binding: null };
}

function defaultLayout(): Layout {
  // Mirrors the original single full-screen "PRESS" button so existing setups
  // keep working after the upgrade.
  return {
    id: uid(),
    name: "Single Button",
    buttons: [{ id: "press", label: "PRESS", color: DEFAULT_COLOR, binding: null }],
  };
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
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(LS.layouts) || "null");
  } catch {
    raw = null;
  }

  if (Array.isArray(raw) && raw.length) {
    const layouts = raw.map(coerceLayout).filter(Boolean) as Layout[];
    if (layouts.length) return layouts;
  }

  // First run (or corrupt store): seed a default layout and migrate any legacy
  // single-button bindings onto it.
  const layout = defaultLayout();
  migrateLegacyBindings(layout.buttons[0].id);
  saveLayouts([layout]);
  setActiveLayoutId(layout.id);
  return [layout];
}

export function saveLayouts(layouts: Layout[]) {
  localStorage.setItem(LS.layouts, JSON.stringify(layouts));
}

export function getActiveLayoutId(): string | null {
  return localStorage.getItem(LS.activeLayoutId);
}

export function setActiveLayoutId(id: string) {
  localStorage.setItem(LS.activeLayoutId, id);
}

export function loadPlayerBindings(): PlayerBindings {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(localStorage.getItem(LS.playerBindings) || "{}");
  } catch {
    return {};
  }
  const out: PlayerBindings = {};
  for (const [userId, perButton] of Object.entries(raw)) {
    if (!perButton || typeof perButton !== "object") continue;
    const map: Record<string, Binding> = {};
    for (const [buttonId, b] of Object.entries(perButton as Record<string, unknown>)) {
      const binding = coerceBinding(b);
      if (binding) map[buttonId] = binding;
    }
    if (Object.keys(map).length) out[userId] = map;
  }
  return out;
}

export function savePlayerBindings(b: PlayerBindings) {
  localStorage.setItem(LS.playerBindings, JSON.stringify(b));
}

// Migrate the original `userId -> Binding` store (a single "press" button) into
// per-player overrides keyed by the new default layout's button id.
function migrateLegacyBindings(buttonId: string) {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(localStorage.getItem(LS.legacyBindings) || "{}");
  } catch {
    return;
  }
  const migrated: PlayerBindings = {};
  for (const [userId, v] of Object.entries(raw)) {
    // Old shapes: plain "KeyA" string, or { modifiers, code }.
    const binding =
      typeof v === "string" ? { code: v, modifiers: [] as Modifier[] } : coerceBinding(v);
    if (binding) migrated[userId] = { [buttonId]: binding };
  }
  if (Object.keys(migrated).length) savePlayerBindings(migrated);
  localStorage.removeItem(LS.legacyBindings);
}

// --- export / import ------------------------------------------------------

const EXPORT_TYPE = "hackbox-keyboard-layout";
const EXPORT_VERSION = 1;

// Serialize a layout (buttons + labels + default keys) for sharing. Per-player
// overrides are intentionally omitted.
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
