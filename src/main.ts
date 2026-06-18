import { invoke } from "@tauri-apps/api/core";
import { emptyState, layoutState } from "./memberState";
import { createHackboxSocket, type HackboxSocket } from "./hackboxSocket";
import {
  duplicateLayout,
  exportLayout,
  getEditingLayoutId,
  importLayout,
  loadLayouts,
  loadPlayers,
  MODIFIER_ORDER,
  newButton,
  saveLayouts,
  savePlayers,
  setEditingLayoutId,
  type Binding,
  type ButtonDef,
  type Layout,
  type Modifier,
  type PlayerConfig,
  type Players,
} from "./layouts";

// ---------------------------------------------------------------------------
// Persistent identity
//
// The server treats any socket whose handshake `userId` equals the room's
// `hostId` as the host (see server RoomService.joinRoom). So we persist a
// stable hostId, create/reuse a room owned by it, and connect with it.
// ---------------------------------------------------------------------------

const LS = {
  hostId: "h2k.hostId",
} as const;

// Fixed Hackbox deployment. The HTTP API is served under /api and the realtime
// relay under /r/<code> on this same apex host (path-routed in production).
const SERVER_URL = "https://hackbox.ca";
const API_BASE = `${new URL(SERVER_URL).origin}/api`;
const RELAY_HOST = new URL(SERVER_URL).host;
const RELAY_PROTOCOL = new URL(SERVER_URL).protocol === "https:" ? "wss" : "ws";

function getHostId(): string {
  let id = localStorage.getItem(LS.hostId);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS.hostId, id);
  }
  return id;
}

const hostId = getHostId();

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

interface Member {
  id: string;
  name: string;
  online: boolean;
}

let layouts: Layout[] = loadLayouts();
let editingLayoutId: string | null = getEditingLayoutId();
let players: Players = loadPlayers();

let socket: HackboxSocket | null = null;
let members: Record<string, Member> = {};
const initialized = new Set<string>(); // players we've pushed an initial state to
// Players who have already joined the *current* room. Unlike `initialized`
// (cleared whenever a player goes offline so we re-push on reconnect), this
// survives reconnects and is only reset when a new room starts — so we can tell
// a genuine first join (→ start blank) from a mid-session reconnect (→ keep the
// host's assignment).
const joinedThisRoom = new Set<string>();

type View = "players" | "layouts" | "editor";
let currentView: View = "players";

// What a key capture, if any, is targeting: a button's default key (in the
// layout editor), or a specific player's override of a button.
type CaptureTarget =
  | { kind: "default"; buttonId: string } // a button's default host key (editor)
  | { kind: "playerKey"; buttonId: string } // the key a player presses on their device
  | { kind: "player"; userId: string; buttonId: string }; // a per-player host-key override
let capture: CaptureTarget | null = null;

// The layout currently open in the editor (null if none / deleted).
function editingLayout(): Layout | undefined {
  return editingLayoutId ? layouts.find((l) => l.id === editingLayoutId) : undefined;
}

function layoutById(id: string | null | undefined): Layout | undefined {
  return id ? layouts.find((l) => l.id === id) : undefined;
}

// The layout a given player is assigned, if any.
function assignedLayout(userId: string): Layout | undefined {
  return layoutById(players[userId]?.layoutId);
}

function ensurePlayer(userId: string): PlayerConfig {
  return (players[userId] ||= { layoutId: null, overrides: {} });
}

function persistLayouts() {
  saveLayouts(layouts);
}

// The binding that actually fires for a player's button: their override if set,
// otherwise the button's default.
function effectiveBinding(userId: string, button: ButtonDef): Binding | null {
  return players[userId]?.overrides[button.id] ?? button.binding;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const el = {
  // views
  viewPlayers: document.getElementById("view-players") as HTMLDivElement,
  viewLayouts: document.getElementById("view-layouts") as HTMLDivElement,
  viewEditor: document.getElementById("view-editor") as HTMLDivElement,
  // players view
  roomCode: document.getElementById("room-code") as HTMLSpanElement,
  newRoomBtn: document.getElementById("new-room-btn") as HTMLButtonElement,
  statusDot: document.getElementById("status-dot") as HTMLSpanElement,
  tabPlayers: document.getElementById("tab-players") as HTMLButtonElement,
  tabLayouts: document.getElementById("tab-layouts") as HTMLButtonElement,
  playerList: document.getElementById("player-list") as HTMLUListElement,
  emptyHint: document.getElementById("empty-hint") as HTMLParagraphElement,
  // layouts index view
  newLayoutBtn: document.getElementById("new-layout-btn") as HTMLButtonElement,
  importBtn: document.getElementById("import-btn") as HTMLButtonElement,
  layoutIndex: document.getElementById("layout-index") as HTMLUListElement,
  layoutsEmptyHint: document.getElementById("layouts-empty-hint") as HTMLParagraphElement,
  // editor view
  editorBack: document.getElementById("editor-back") as HTMLButtonElement,
  layoutName: document.getElementById("layout-name") as HTMLInputElement,
  layoutButtons: document.getElementById("layout-buttons") as HTMLUListElement,
  addButtonBtn: document.getElementById("add-button-btn") as HTMLButtonElement,
  // import dialog
  importDialog: document.getElementById("import-dialog") as HTMLDialogElement,
  importText: document.getElementById("import-text") as HTMLTextAreaElement,
  importFile: document.getElementById("import-file") as HTMLInputElement,
  importError: document.getElementById("import-error") as HTMLParagraphElement,
  importConfirm: document.getElementById("import-confirm") as HTMLButtonElement,
  // confirm dialog
  confirmDialog: document.getElementById("confirm-dialog") as HTMLDialogElement,
  confirmTitle: document.getElementById("confirm-title") as HTMLHeadingElement,
  confirmMessage: document.getElementById("confirm-message") as HTMLParagraphElement,
  confirmOk: document.getElementById("confirm-ok") as HTMLButtonElement,
  toast: document.getElementById("toast") as HTMLDivElement,
};

// Promise-based confirmation built on a native <dialog> — Tauri's WebView
// doesn't implement the synchronous window.confirm(), so it always returned
// false and (e.g.) Delete silently did nothing. The <form method="dialog">
// sets returnValue to the clicked button's value; Esc closes with "".
function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel: string;
}): Promise<boolean> {
  el.confirmTitle.textContent = opts.title;
  el.confirmMessage.textContent = opts.message;
  el.confirmOk.textContent = opts.confirmLabel;
  el.confirmDialog.showModal();
  return new Promise((resolve) => {
    el.confirmDialog.addEventListener(
      "close",
      () => resolve(el.confirmDialog.returnValue === "confirm"),
      { once: true },
    );
  });
}

// The dot's colour conveys the connection state at a glance; the full message
// (room code, errors, reconnecting) lives in its tooltip since the persistent
// status text was dropped in favour of the Manage layouts button.
function setStatus(state: "online" | "offline" | "connecting", text: string) {
  el.statusDot.className = `dot ${state}`;
  el.statusDot.title = text;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function showView(view: View) {
  // Leaving the editor or a list cancels any in-progress key capture.
  if (view !== currentView) capture = null;
  currentView = view;
  el.viewPlayers.hidden = view !== "players";
  el.viewLayouts.hidden = view !== "layouts";
  el.viewEditor.hidden = view !== "editor";

  // The editor is a drill-down within the Layouts tab, so it keeps that tab lit.
  const layoutsActive = view === "layouts" || view === "editor";
  el.tabPlayers.classList.toggle("active", view === "players");
  el.tabLayouts.classList.toggle("active", layoutsActive);
  el.tabPlayers.setAttribute("aria-selected", String(view === "players"));
  el.tabLayouts.setAttribute("aria-selected", String(layoutsActive));

  if (view === "players") renderPlayers();
  if (view === "layouts") renderLayoutIndex();
  if (view === "editor") renderEditor();
}

function openEditor(id: string) {
  editingLayoutId = id;
  setEditingLayoutId(id);
  showView("editor");
}

// --- key labelling --------------------------------------------------------

// Human-friendly label for a KeyboardEvent.code.
function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const map: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Escape: "Esc",
    Backspace: "Backspace",
    Tab: "Tab",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  return map[code] || code;
}

const MOD_LABEL: Record<Modifier, string> = {
  Control: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Meta: "Meta",
};

// "Shift+J", "Ctrl+Meta+Space", etc.
function bindingLabel(b: Binding): string {
  return [...b.modifiers.map((m) => MOD_LABEL[m]), keyLabel(b.code)].join("+");
}

// Friendly label for a player key (a KeyboardEvent.key value, e.g. " " or "a").
function playerKeyLabel(key: string): string {
  if (key === " ") return "Space";
  const map: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
  };
  if (map[key]) return map[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Render: layouts index
// ---------------------------------------------------------------------------

function renderLayoutIndex() {
  el.layoutsEmptyHint.style.display = layouts.length ? "none" : "block";
  el.layoutIndex.innerHTML = "";
  for (const layout of layouts) {
    el.layoutIndex.appendChild(renderLayoutIndexRow(layout));
  }
}

function renderLayoutIndexRow(layout: Layout): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "layout-index-row";
  li.dataset.id = layout.id;
  // Not draggable by default — only a press on the grip arms it (see
  // wireRowDrag). Otherwise the whole row drags from anywhere and, worse, a
  // mousedown on Edit/Delete starts a drag instead of firing the click.

  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = "⠿";
  grip.title = "Drag to reorder";

  const meta = document.createElement("div");
  meta.className = "layout-meta";
  const n = layout.buttons.length;
  meta.innerHTML = `
    <span class="layout-title">${escapeHtml(layout.name) || "Untitled"}</span>
    <span class="layout-sub">${n} button${n === 1 ? "" : "s"}</span>
  `;

  // Per-layout actions, as icon buttons. All layout management lives here on the
  // index — the editor itself has no duplicate/export/delete controls.
  const edit = iconButton("✎", "Edit layout");
  edit.addEventListener("click", () => openEditor(layout.id));

  const dup = iconButton("⧉", "Duplicate layout");
  dup.addEventListener("click", () => duplicateLayoutById(layout.id));

  const exp = iconButton("⤓", "Export layout (copy & download JSON)");
  exp.addEventListener("click", () => void exportLayoutFile(layout));

  const del = iconButton("×", "Delete layout", true);
  del.addEventListener("click", () => void deleteLayout(layout.id));

  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.append(edit, dup, exp, del);

  li.append(grip, meta, actions);
  wireRowDrag(li, grip);
  return li;
}

// A square icon button (monochrome glyph) with an accessible label/tooltip.
function iconButton(glyph: string, label: string, danger = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon-btn" + (danger ? " danger" : "");
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

// --- drag reordering ------------------------------------------------------

// Standard HTML5 drag-and-drop reorder: the dragged row moves live in the DOM
// during dragover; on drop we rebuild the `layouts` array from the DOM order.
//
// The row is only `draggable` while the pointer is pressed on the grip handle,
// so a drag can only start from the handle and clicks on the row's own buttons
// (Edit/Delete) aren't swallowed by an accidental drag.
function wireRowDrag(li: HTMLLIElement, grip: HTMLElement) {
  const disarm = () => {
    li.draggable = false;
  };
  grip.addEventListener("mousedown", () => {
    li.draggable = true;
  });
  // A press that doesn't turn into a drag (a plain click on the grip) must
  // still disarm so the row can't be dragged from elsewhere afterwards.
  grip.addEventListener("mouseup", disarm);

  li.addEventListener("dragstart", (e) => {
    li.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", li.dataset.id || "");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    disarm();
    commitIndexOrder();
  });
}

el.layoutIndex.addEventListener("dragover", (e) => {
  e.preventDefault();
  // WebKit (the Tauri macOS WebView) only treats a target as a valid drop zone
  // when dropEffect is set to match the drag's effectAllowed ("move"); without
  // this it shows the no-drop cursor and rejects every position.
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  const dragging = el.layoutIndex.querySelector(".dragging") as HTMLElement | null;
  if (!dragging) return;
  const after = dragAfterElement(el.layoutIndex, e.clientY);
  if (after == null) el.layoutIndex.appendChild(dragging);
  else el.layoutIndex.insertBefore(dragging, after);
});

// Accept the drop so the row settles in place (and WebKit fires `dragend`
// normally) rather than animating back to its origin. Order is committed on
// `dragend`, which fires after this.
el.layoutIndex.addEventListener("drop", (e) => e.preventDefault());

function dragAfterElement(container: HTMLElement, y: number): HTMLElement | null {
  const rows = [...container.querySelectorAll<HTMLElement>(".layout-index-row:not(.dragging)")];
  let closest: { offset: number; element: HTMLElement | null } = {
    offset: Number.NEGATIVE_INFINITY,
    element: null,
  };
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: row };
  }
  return closest.element;
}

// Re-derive layout order from the current DOM, persist it, and refresh the
// player dropdowns (which list layouts in this order).
function commitIndexOrder() {
  const order = [...el.layoutIndex.querySelectorAll<HTMLElement>(".layout-index-row")].map(
    (li) => li.dataset.id,
  );
  const byId = new Map(layouts.map((l) => [l.id, l]));
  const reordered = order.map((id) => byId.get(id!)).filter(Boolean) as Layout[];
  if (reordered.length !== layouts.length) return; // safety: don't lose any
  const changed = reordered.some((l, i) => l.id !== layouts[i].id);
  if (!changed) return;
  layouts = reordered;
  persistLayouts();
}

// ---------------------------------------------------------------------------
// Render: layout editor
// ---------------------------------------------------------------------------

function renderEditor() {
  const layout = editingLayout();
  if (!layout) {
    // The edited layout is gone (e.g. deleted) — bounce back to the index.
    showView("layouts");
    return;
  }

  el.layoutName.value = layout.name;

  el.layoutButtons.innerHTML = "";
  layout.buttons.forEach((button) => {
    el.layoutButtons.appendChild(renderButtonRow(layout, button));
  });
}

function renderButtonRow(layout: Layout, button: ButtonDef): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "layout-button-row";

  // Top line: colour, label, delete.
  const top = document.createElement("div");
  top.className = "lbr-top";

  const color = document.createElement("input");
  color.type = "color";
  color.className = "color-input";
  color.value = button.color;
  color.title = "Button colour";
  color.addEventListener("input", () => {
    button.color = color.value;
    persistLayouts();
    scheduleRepushLayout(layout.id);
  });

  const label = document.createElement("input");
  label.type = "text";
  label.className = "label-input";
  label.value = button.label;
  label.placeholder = "Button label";
  label.addEventListener("input", () => {
    button.label = label.value;
    persistLayouts();
    scheduleRepushLayout(layout.id);
  });

  const del = document.createElement("button");
  del.className = "icon-btn danger";
  del.textContent = "×";
  del.title = "Remove button";
  del.setAttribute("aria-label", "Remove button");
  del.addEventListener("click", () => removeButton(layout, button.id));

  top.append(color, label, del);

  // Keys line: the key the player presses on their device, and the default key
  // pressed on this computer.
  const keys = document.createElement("div");
  keys.className = "lbr-keys";

  // Player key.
  const playerCapturing =
    capture?.kind === "playerKey" && capture.buttonId === button.id;
  const playerField = document.createElement("div");
  playerField.className = "lbr-key";
  const playerLbl = document.createElement("span");
  playerLbl.className = "lbr-key-label";
  playerLbl.textContent = "Player presses";
  const playerBtn = document.createElement("button");
  playerBtn.className =
    `key-btn${playerCapturing ? " capturing" : ""}${button.playerKey ? "" : " unset"}`;
  playerBtn.textContent = playerCapturing
    ? "Press a key…"
    : button.playerKey
      ? playerKeyLabel(button.playerKey)
      : "Tap only";
  playerBtn.title = "Key the player presses on their OWN device to fire this button";
  playerBtn.addEventListener("click", () => {
    capture = playerCapturing ? null : { kind: "playerKey", buttonId: button.id };
    renderEditor();
  });
  playerField.append(playerLbl, playerBtn);
  if (button.playerKey) {
    const clear = document.createElement("button");
    clear.className = "reset-btn";
    clear.textContent = "×";
    clear.title = "Remove player key (tap only)";
    clear.setAttribute("aria-label", "Remove player key");
    clear.addEventListener("click", () => setPlayerKey(layout, button, null));
    playerField.append(clear);
  }

  // Default host key.
  const hostCapturing = capture?.kind === "default" && capture.buttonId === button.id;
  const hostField = document.createElement("div");
  hostField.className = "lbr-key";
  const hostLbl = document.createElement("span");
  hostLbl.className = "lbr-key-label";
  hostLbl.textContent = "Sends (default)";
  const hostBtn = document.createElement("button");
  hostBtn.className = `key-btn${hostCapturing ? " capturing" : ""}${button.binding ? "" : " unset"}`;
  hostBtn.textContent = hostCapturing
    ? "Press keys…"
    : button.binding
      ? bindingLabel(button.binding)
      : "Default key";
  hostBtn.title = "Key pressed on THIS computer (a player can override it)";
  hostBtn.addEventListener("click", () => {
    capture = hostCapturing ? null : { kind: "default", buttonId: button.id };
    renderEditor();
  });
  hostField.append(hostLbl, hostBtn);

  keys.append(playerField, hostField);

  li.append(top, keys);
  return li;
}

// ---------------------------------------------------------------------------
// Render: players
// ---------------------------------------------------------------------------

function renderPlayers() {
  const list = Object.values(members).sort((a, b) => a.name.localeCompare(b.name));
  el.emptyHint.style.display = list.length ? "none" : "block";
  el.playerList.innerHTML = "";

  for (const m of list) {
    el.playerList.appendChild(renderPlayerCard(m));
  }
}

function renderPlayerCard(member: Member): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "player" + (member.online ? "" : " offline");
  li.dataset.id = member.id;

  // Header: status dot, name, and the per-player layout assignment.
  const head = document.createElement("div");
  head.className = "player-head";
  head.innerHTML = `
    <span class="player-dot ${member.online ? "online" : "offline"}"></span>
    <span class="player-name">${escapeHtml(member.name)}</span>
  `;

  const select = document.createElement("select");
  select.className = "layout-assign";
  select.title = "Layout for this player";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No layout";
  select.appendChild(none);
  for (const l of layouts) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name || "Untitled";
    select.appendChild(opt);
  }
  select.value = players[member.id]?.layoutId ?? "";
  select.addEventListener("change", () =>
    setPlayerLayout(member.id, select.value || null),
  );
  head.appendChild(select);
  li.appendChild(head);

  // Bindings for the assigned layout, if any.
  const layout = assignedLayout(member.id);
  if (layout && layout.buttons.length) {
    const grid = document.createElement("div");
    grid.className = "player-bindings";
    for (const button of layout.buttons) {
      grid.appendChild(renderPlayerBinding(member, button));
    }
    li.appendChild(grid);
  }

  return li;
}

function renderPlayerBinding(member: Member, button: ButtonDef): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "binding";

  const name = document.createElement("span");
  name.className = "binding-label";
  name.textContent = button.label || "(unnamed)";

  const override = players[member.id]?.overrides[button.id];
  const effective = override ?? button.binding;
  const isCapturing =
    capture?.kind === "player" &&
    capture.userId === member.id &&
    capture.buttonId === button.id;

  const keyBtn = document.createElement("button");
  keyBtn.dataset.buttonId = button.id; // so a tap can flash this exact control
  keyBtn.className =
    "bind-btn" +
    (isCapturing ? " capturing" : "") +
    (effective ? "" : " unset") +
    (override ? " override" : "");
  keyBtn.textContent = isCapturing
    ? "Press keys…"
    : effective
      ? bindingLabel(effective)
      : "Set key";
  keyBtn.title = override
    ? "Per-player key (overrides the layout default)"
    : effective
      ? "Using the layout's default key"
      : "No key set";
  keyBtn.addEventListener("click", () => {
    capture = isCapturing
      ? null
      : { kind: "player", userId: member.id, buttonId: button.id };
    renderPlayers();
  });

  wrap.append(name, keyBtn);

  // Allow reverting a per-player override back to the layout default.
  if (override) {
    const reset = document.createElement("button");
    reset.className = "reset-btn";
    reset.textContent = "↺";
    reset.title = "Reset to default key";
    reset.setAttribute("aria-label", "Reset to default key");
    reset.addEventListener("click", () => clearOverride(member.id, button.id));
    wrap.appendChild(reset);
  }

  return wrap;
}

function flashPlayer(userId: string) {
  const li = el.playerList.querySelector(`li[data-id="${CSS.escape(userId)}"]`);
  if (!li) return;
  li.classList.remove("hit");
  void (li as HTMLElement).offsetWidth; // restart the CSS animation
  li.classList.add("hit");
}

// Pulse the specific button's key control on the player's card, so the host can
// see *which* button was tapped (not just which player). No-ops if that card
// isn't currently in the DOM (e.g. the host is on the Layouts tab).
function flashButton(userId: string, buttonId: string) {
  const btn = el.playerList.querySelector<HTMLElement>(
    `li[data-id="${CSS.escape(userId)}"] .bind-btn[data-button-id="${CSS.escape(buttonId)}"]`,
  );
  if (!btn) return;
  btn.classList.remove("hit");
  void btn.offsetWidth; // restart the CSS animation
  btn.classList.add("hit");
}

// ---------------------------------------------------------------------------
// Layout & binding mutations
// ---------------------------------------------------------------------------

function addButton() {
  const layout = editingLayout();
  if (!layout) return;
  layout.buttons.push(newButton(`Button ${layout.buttons.length + 1}`));
  persistLayouts();
  renderEditor();
  void pushLayoutToAssigned(layout.id);
}

function removeButton(layout: Layout, buttonId: string) {
  layout.buttons = layout.buttons.filter((b) => b.id !== buttonId);
  // Drop any per-player overrides for the removed button.
  for (const config of Object.values(players)) delete config.overrides[buttonId];
  persistLayouts();
  savePlayers(players);
  renderEditor();
  void pushLayoutToAssigned(layout.id);
}

// Set (or clear) the key a player presses on their own device for a button.
// Changing it alters the pushed `keys`, so re-push to assigned players.
function setPlayerKey(layout: Layout, button: ButtonDef, key: string | null) {
  button.playerKey = key;
  persistLayouts();
  renderEditor();
  void pushLayoutToAssigned(layout.id);
}

function clearOverride(userId: string, buttonId: string) {
  const config = players[userId];
  if (!config) return;
  delete config.overrides[buttonId];
  savePlayers(players);
  renderPlayers();
}

function setPlayerLayout(userId: string, layoutId: string | null) {
  ensurePlayer(userId).layoutId = layoutId;
  savePlayers(players);
  capture = null;
  renderPlayers();
  pushToPlayer(userId);
}

function createLayout() {
  const layout: Layout = {
    id: crypto.randomUUID(),
    name: `Layout ${layouts.length + 1}`,
    buttons: [newButton("Button 1")],
  };
  layouts.push(layout);
  persistLayouts();
  openEditor(layout.id);
  el.layoutName.focus();
  el.layoutName.select();
}

function duplicateLayoutById(id: string) {
  const idx = layouts.findIndex((l) => l.id === id);
  if (idx === -1) return;
  const source = layouts[idx];
  const copy = duplicateLayout(source, `${source.name} copy`);
  // Drop the copy right after its original so it's easy to find in the list.
  layouts.splice(idx + 1, 0, copy);
  persistLayouts();
  renderLayoutIndex();
  toast(`Duplicated "${source.name}"`);
}

async function deleteLayout(id: string) {
  const removed = layouts.find((l) => l.id === id);
  if (!removed) return;
  const ok = await confirmDialog({
    title: "Delete layout",
    message: `Delete "${removed.name}"? This can't be undone.`,
    confirmLabel: "Delete",
  });
  if (!ok) return;

  layouts = layouts.filter((l) => l.id !== id);
  persistLayouts();

  // Unassign anyone who was on it; they fall back to a blank screen.
  const affected: string[] = [];
  for (const [userId, config] of Object.entries(players)) {
    if (config.layoutId === id) {
      config.layoutId = null;
      affected.push(userId);
    }
  }
  savePlayers(players);

  if (editingLayoutId === id) editingLayoutId = null;
  renderLayoutIndex();
  for (const userId of affected) pushToPlayer(userId);
}

// ---------------------------------------------------------------------------
// Key capture: bind the next physical key to the current capture target
// ---------------------------------------------------------------------------

// Codes for the modifier keys themselves — pressing one alone shouldn't finish
// the capture; we wait for the main (non-modifier) key and record whichever
// modifiers are held at that moment.
const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

window.addEventListener("keydown", (e) => {
  if (!capture) return;
  e.preventDefault();
  if (e.code === "Escape") {
    capture = null;
    rerenderCaptureView();
    return;
  }
  if (MODIFIER_CODES.has(e.code)) return; // hold for the main key

  // Player key: store the produced KeyboardEvent.key (what the hackbox client
  // matches against), with no modifiers — ChoiceButton ignores them.
  if (capture.kind === "playerKey") {
    const layout = editingLayout();
    const button = layout?.buttons.find((b) => b.id === capture!.buttonId);
    if (layout && button) {
      capture = null;
      setPlayerKey(layout, button, e.key);
      return;
    }
    capture = null;
    rerenderCaptureView();
    return;
  }

  const modifiers: Modifier[] = [];
  if (e.ctrlKey) modifiers.push("Control");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");
  if (e.metaKey) modifiers.push("Meta");
  // Keep modifiers in a stable, canonical order.
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  const binding: Binding = { modifiers: ordered, code: e.code };

  if (capture.kind === "default") {
    const button = editingLayout()?.buttons.find((b) => b.id === capture!.buttonId);
    if (button) {
      button.binding = binding;
      persistLayouts();
    }
  } else {
    ensurePlayer(capture.userId).overrides[capture.buttonId] = binding;
    savePlayers(players);
  }

  capture = null;
  rerenderCaptureView();
});

// Re-render whichever view owns the capture UI.
function rerenderCaptureView() {
  if (currentView === "editor") renderEditor();
  else renderPlayers();
}

// ---------------------------------------------------------------------------
// OS keypress dispatch (Rust/enigo via Tauri command)
// ---------------------------------------------------------------------------

async function pressKey(b: Binding) {
  try {
    await invoke("press_key", { code: b.code, modifiers: b.modifiers });
  } catch (err) {
    console.error("press_key failed", err);
  }
}

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

// Allocate a brand-new room owned by this host. We deliberately create a fresh
// code on every launch rather than reusing a stored one, so the room never
// outlives the app session. `apiBase` is the HTTP front door, e.g.
// "https://app.hackbox.ca/api".
async function createRoom(apiBase: string): Promise<string> {
  const res = await fetch(`${apiBase}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostId }),
  });
  const data = await res.json();
  if (!data.ok || !data.roomCode) {
    throw new Error(data.error || "Failed to create room");
  }
  return data.roomCode;
}

// Push a player's current state: their assigned layout, or a blank screen if
// they have none. Buttons are pushed `persistent`, so this is only needed when
// the player's layout actually changes — not to re-arm after each tap.
function pushToPlayer(userId: string) {
  if (!socket) return;
  const name = members[userId]?.name || "";
  const layout = assignedLayout(userId);
  socket.emit("member.update", {
    to: userId,
    data: layout ? layoutState(name, layout) : emptyState(name),
  });
}

// Re-push to every online player currently assigned the given layout (after its
// structure — labels/colours/buttons — changed).
function pushLayoutToAssigned(layoutId: string) {
  if (!socket) return;
  for (const m of Object.values(members)) {
    if (m.online && players[m.id]?.layoutId === layoutId) pushToPlayer(m.id);
  }
}

// Label/colour edits arrive keystroke-by-keystroke; debounce the re-push so we
// don't spam the relay while the host is typing.
let repushTimer: ReturnType<typeof setTimeout> | null = null;
let repushLayoutId: string | null = null;
function scheduleRepushLayout(layoutId: string) {
  repushLayoutId = layoutId;
  if (repushTimer !== null) clearTimeout(repushTimer);
  repushTimer = setTimeout(() => {
    repushTimer = null;
    if (repushLayoutId) pushLayoutToAssigned(repushLayoutId);
  }, 350);
}

// Reasons partysocket recovers from on its own (it reconnects and re-fires
// "connect"); anything else is a fatal close (room expired/gone, duplicate
// device) that needs a brand-new room.
const TRANSIENT_REASONS = new Set(["transport close", "transport error"]);
let recreateTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRecreate() {
  if (recreateTimer !== null) return;
  recreateTimer = setTimeout(() => {
    recreateTimer = null;
    void connect(); // connect() always allocates a fresh room
  }, 3000);
}

async function connect() {
  // Cancel a queued auto-recreate; we're (re)connecting now.
  if (recreateTimer !== null) {
    clearTimeout(recreateTimer);
    recreateTimer = null;
  }
  setStatus("connecting", "Connecting…");

  let roomCode: string;
  try {
    roomCode = await createRoom(API_BASE);
  } catch (err) {
    setStatus("offline", `Room error: ${(err as Error).message}`);
    scheduleRecreate(); // retry shortly; no manual reconnect button
    return;
  }

  el.roomCode.textContent = roomCode;

  // A brand-new room: every player that joins it counts as a fresh join, so
  // they all start blank regardless of earlier assignments.
  joinedThisRoom.clear();
  initialized.clear();

  socket?.close();
  socket = createHackboxSocket({
    protocol: RELAY_PROTOCOL,
    host: RELAY_HOST,
    roomCode,
    userId: hostId,
  });

  socket.on("connect", () => {
    setStatus("online", `Hosting ${roomCode}`);
  });

  socket.on("disconnect", (reason) => {
    const r = String(reason);
    if (TRANSIENT_REASONS.has(r)) {
      // partysocket is already reconnecting under the hood.
      setStatus("connecting", "Reconnecting…");
      return;
    }
    // Fatal: the room is gone. Spin up a new one automatically.
    setStatus("offline", `Disconnected: ${r}`);
    scheduleRecreate();
  });

  socket.on("error", (payload) => {
    const message = (payload as { message?: string })?.message;
    setStatus("offline", message || "Server error");
  });

  // Roster updates: relay sends the full member map each time it changes.
  socket.on("state.host", (payload) => {
    members = (payload as { members?: Record<string, Member> }).members || {};
    for (const m of Object.values(members)) {
      if (m.online) {
        // First time we see this player in this room: clear any layout they
        // carried over from a previous room/session — players always start
        // blank on join. (A reconnect keeps whatever the host assigned since.)
        if (!joinedThisRoom.has(m.id)) {
          joinedThisRoom.add(m.id);
          const config = players[m.id];
          if (config && config.layoutId !== null) {
            config.layoutId = null;
            savePlayers(players);
          }
        }
        if (!initialized.has(m.id)) {
          initialized.add(m.id);
          pushToPlayer(m.id);
        }
      } else {
        initialized.delete(m.id);
      }
    }
    if (currentView === "players") renderPlayers();
  });

  // A player tapped one of their buttons. The Button's `event` is its id.
  socket.on("msg", (payload) => {
    const p = payload as { from?: string; event?: string };
    const from = p?.from;
    if (!from) return;
    const layout = assignedLayout(from);
    const button = layout?.buttons.find((b) => b.id === p.event);
    if (button) {
      const binding = effectiveBinding(from, button);
      if (binding) void pressKey(binding);
      // No re-push needed: the buttons are pushed `persistent`, so they stay
      // armed for repeated taps (see layoutState).
      flashButton(from, button.id);
    }
    flashPlayer(from);
  });
}

// Discard the current room and spin up a fresh one on demand. (A fresh room is
// also allocated on every launch.) Existing players need the new code to rejoin.
async function newRoom() {
  el.newRoomBtn.disabled = true;
  members = {};
  initialized.clear();
  el.roomCode.textContent = "————";
  renderPlayers();
  await connect();
  el.newRoomBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

async function exportLayoutFile(layout: Layout) {
  const json = exportLayout(layout);

  // Offer a file download…
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (layout.name || "layout").replace(/[^a-z0-9-_]+/gi, "-");
  a.href = url;
  a.download = `${safeName}.hackboxkb.json`;
  a.click();
  URL.revokeObjectURL(url);

  // …and copy to the clipboard for quick pasting.
  try {
    await navigator.clipboard.writeText(json);
    toast("Layout copied to clipboard & downloaded");
  } catch {
    toast("Layout downloaded");
  }
}

function openImport() {
  el.importText.value = "";
  el.importFile.value = "";
  el.importError.textContent = "";
  el.importDialog.showModal();
}

function applyImport(json: string): boolean {
  try {
    const layout = importLayout(json);
    layouts.push(layout);
    persistLayouts();
    toast(`Imported "${layout.name}"`);
    openEditor(layout.id); // jump straight into editing the imported layout
    return true;
  } catch (err) {
    el.importError.textContent = (err as Error).message;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wire up DOM events
// ---------------------------------------------------------------------------

// persistent header + tabs
el.newRoomBtn.addEventListener("click", () => void newRoom());
el.tabPlayers.addEventListener("click", () => showView("players"));
el.tabLayouts.addEventListener("click", () => showView("layouts"));

// layouts index view
el.newLayoutBtn.addEventListener("click", () => createLayout());
el.importBtn.addEventListener("click", () => openImport());

// editor view
el.editorBack.addEventListener("click", () => showView("layouts"));
el.layoutName.addEventListener("input", () => {
  const layout = editingLayout();
  if (layout) {
    layout.name = el.layoutName.value;
    persistLayouts();
  }
});
el.addButtonBtn.addEventListener("click", () => addButton());

// import dialog
el.importFile.addEventListener("change", async () => {
  const file = el.importFile.files?.[0];
  if (file) el.importText.value = await file.text();
});
// Validate before closing so a bad paste keeps the dialog open with the error.
el.importConfirm.addEventListener("click", (e) => {
  e.preventDefault();
  if (applyImport(el.importText.value)) el.importDialog.close("import");
});

// Show the home view, then create/reuse a room and connect on launch.
showView("players");
void connect();
