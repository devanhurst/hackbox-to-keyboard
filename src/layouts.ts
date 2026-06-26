import { storage } from "./storage";

export type Modifier = "Control" | "Alt" | "Shift" | "Meta";

export interface Binding {
  modifiers: Modifier[];
  code: string;
}

export interface ButtonDef {
  id: string;
  label: string;
  color: string;
  binding: Binding | null;
  playerKey: string | null;
}

export interface Layout {
  id: string;
  name: string;
  buttons: ButtonDef[];
}

export interface PlayerConfig {
  layoutId: string | null;
  overrides: Record<string, Binding>;
  /** Whether this player's presses reach the keyboard (gated by the master switch too). */
  enabled: boolean;
}

export type Players = Record<string, PlayerConfig>;

export const MODIFIER_ORDER: Modifier[] = ["Control", "Alt", "Shift", "Meta"];

const orderModifiers = (list: readonly unknown[]): Modifier[] =>
  MODIFIER_ORDER.filter((m) => list.includes(m));

const LS = {
  layouts: "h2k.layouts",
  editingLayoutId: "h2k.editingLayoutId",
  players: "h2k.players",
  legacyBindings: "h2k.bindings",
} as const;

const DEFAULT_COLOR = "#7c5cff";

const uid = () => crypto.randomUUID();

export function newButton(label = "Button", color = DEFAULT_COLOR): ButtonDef {
  return { id: uid(), label, color, binding: null, playerKey: null };
}

export function newLayout(
  name: string,
  buttons: ButtonDef[] = [newButton("Button 1")],
): Layout {
  return { id: uid(), name, buttons };
}

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
  return newLayout("Buzzer", [
    { id: uid(), label: "BUZZ", color: "#ef4444", binding: null, playerKey: " " },
  ]);
}

export const NO_KEY = "tap";

export function encodeBinding(b: Binding | null): string {
  if (!b) return NO_KEY;
  return [...orderModifiers(b.modifiers), b.code].join("+");
}

function coerceModifiers(v: unknown): Modifier[] {
  return Array.isArray(v) ? orderModifiers(v) : [];
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

export function loadLayouts(): Layout[] {
  const stored = storage.getItem(LS.layouts);
  if (stored !== null) {
    try {
      const raw = JSON.parse(stored);
      if (Array.isArray(raw)) return raw.map(coerceLayout).filter(Boolean) as Layout[];
    } catch {}
  }

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
      enabled: c.enabled !== false,
    };
  }
  return out;
}

export function savePlayers(players: Players) {
  storage.setItem(LS.players, JSON.stringify(players));
}

function migrateLegacyBindings(layoutId: string, buttonId: string) {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(storage.getItem(LS.legacyBindings) || "{}");
  } catch {
    return;
  }
  const players: Players = {};
  for (const [userId, v] of Object.entries(raw)) {
    const binding =
      typeof v === "string" ? { code: v, modifiers: [] as Modifier[] } : coerceBinding(v);
    if (binding)
      players[userId] = { layoutId, overrides: { [buttonId]: binding }, enabled: true };
  }
  if (Object.keys(players).length) savePlayers(players);
  storage.removeItem(LS.legacyBindings);
}

const EXPORT_TYPE = "hackbox-keyboard-layout";
const EXPORT_VERSION = 1;

export function exportLayout(layout: Layout): string {
  return JSON.stringify(
    { type: EXPORT_TYPE, version: EXPORT_VERSION, layout },
    null,
    2,
  );
}

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
  layout.id = uid();
  return layout;
}
