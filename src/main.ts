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
  roomCode: "h2k.roomCode",
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
let editingLayoutId: string = resolveEditingLayoutId();
let players: Players = loadPlayers();

let socket: HackboxSocket | null = null;
let members: Record<string, Member> = {};
const initialized = new Set<string>(); // players we've pushed an initial state to

// What a key capture, if any, is targeting: a button's default key (in the
// layout editor), or a specific player's override of a button.
type CaptureTarget =
  | { kind: "default"; buttonId: string }
  | { kind: "player"; userId: string; buttonId: string };
let capture: CaptureTarget | null = null;

function resolveEditingLayoutId(): string {
  const stored = getEditingLayoutId();
  if (stored && layouts.some((l) => l.id === stored)) return stored;
  const id = layouts[0].id;
  setEditingLayoutId(id);
  return id;
}

// The layout currently shown in the editor panel.
function editingLayout(): Layout {
  return layouts.find((l) => l.id === editingLayoutId) ?? layouts[0];
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
  roomCode: document.getElementById("room-code") as HTMLSpanElement,
  newRoomBtn: document.getElementById("new-room-btn") as HTMLButtonElement,
  statusDot: document.getElementById("status-dot") as HTMLSpanElement,
  statusText: document.getElementById("status-text") as HTMLSpanElement,
  layoutSelect: document.getElementById("layout-select") as HTMLSelectElement,
  newLayoutBtn: document.getElementById("new-layout-btn") as HTMLButtonElement,
  layoutName: document.getElementById("layout-name") as HTMLInputElement,
  layoutButtons: document.getElementById("layout-buttons") as HTMLUListElement,
  addButtonBtn: document.getElementById("add-button-btn") as HTMLButtonElement,
  duplicateLayoutBtn: document.getElementById("duplicate-layout-btn") as HTMLButtonElement,
  exportBtn: document.getElementById("export-btn") as HTMLButtonElement,
  importBtn: document.getElementById("import-btn") as HTMLButtonElement,
  deleteLayoutBtn: document.getElementById("delete-layout-btn") as HTMLButtonElement,
  playerList: document.getElementById("player-list") as HTMLUListElement,
  emptyHint: document.getElementById("empty-hint") as HTMLParagraphElement,
  importDialog: document.getElementById("import-dialog") as HTMLDialogElement,
  importText: document.getElementById("import-text") as HTMLTextAreaElement,
  importFile: document.getElementById("import-file") as HTMLInputElement,
  importError: document.getElementById("import-error") as HTMLParagraphElement,
  importConfirm: document.getElementById("import-confirm") as HTMLButtonElement,
  toast: document.getElementById("toast") as HTMLDivElement,
};

function setStatus(state: "online" | "offline" | "connecting", text: string) {
  el.statusDot.className = `dot ${state}`;
  el.statusText.textContent = text;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
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

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Render: layout editor
// ---------------------------------------------------------------------------

function renderLayoutPanel() {
  const layout = editingLayout();

  // Layout picker.
  el.layoutSelect.innerHTML = "";
  for (const l of layouts) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name || "Untitled";
    opt.selected = l.id === layout.id;
    el.layoutSelect.appendChild(opt);
  }

  el.layoutName.value = layout.name;
  el.deleteLayoutBtn.disabled = layouts.length <= 1;

  // Button editor rows.
  el.layoutButtons.innerHTML = "";
  layout.buttons.forEach((button) => {
    el.layoutButtons.appendChild(renderButtonRow(layout, button));
  });
}

function renderButtonRow(layout: Layout, button: ButtonDef): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "layout-button-row";

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

  const isCapturing = capture?.kind === "default" && capture.buttonId === button.id;
  const keyBtn = document.createElement("button");
  keyBtn.className = `key-btn${isCapturing ? " capturing" : ""}${button.binding ? "" : " unset"}`;
  keyBtn.textContent = isCapturing
    ? "Press keys…"
    : button.binding
      ? bindingLabel(button.binding)
      : "Default key";
  keyBtn.title = "Default key (used unless a player overrides it)";
  keyBtn.addEventListener("click", () => {
    capture = isCapturing ? null : { kind: "default", buttonId: button.id };
    render();
  });

  const del = document.createElement("button");
  del.className = "icon-btn danger";
  del.textContent = "×";
  del.title = "Remove button";
  del.setAttribute("aria-label", "Remove button");
  del.addEventListener("click", () => removeButton(layout, button.id));

  li.append(color, label, keyBtn, del);
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
    render();
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

function render() {
  renderLayoutPanel();
  renderPlayers();
}

function flashPlayer(userId: string) {
  const li = el.playerList.querySelector(`li[data-id="${CSS.escape(userId)}"]`);
  if (!li) return;
  li.classList.remove("hit");
  void (li as HTMLElement).offsetWidth; // restart the CSS animation
  li.classList.add("hit");
}

// ---------------------------------------------------------------------------
// Layout & binding mutations
// ---------------------------------------------------------------------------

function addButton() {
  const layout = editingLayout();
  layout.buttons.push(newButton(`Button ${layout.buttons.length + 1}`));
  persistLayouts();
  render();
  void pushLayoutToAssigned(layout.id);
}

function removeButton(layout: Layout, buttonId: string) {
  layout.buttons = layout.buttons.filter((b) => b.id !== buttonId);
  // Drop any per-player overrides for the removed button.
  for (const config of Object.values(players)) delete config.overrides[buttonId];
  persistLayouts();
  savePlayers(players);
  render();
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

function selectEditingLayout(id: string) {
  if (id === editingLayoutId) return;
  editingLayoutId = id;
  setEditingLayoutId(id);
  capture = null;
  renderLayoutPanel();
}

function createLayout() {
  const layout: Layout = {
    id: crypto.randomUUID(),
    name: `Layout ${layouts.length + 1}`,
    buttons: [newButton("Button 1")],
  };
  layouts.push(layout);
  persistLayouts();
  editingLayoutId = layout.id;
  setEditingLayoutId(layout.id);
  capture = null;
  render(); // players panel needs the new layout in its assignment dropdowns
  el.layoutName.focus();
  el.layoutName.select();
}

function duplicateCurrentLayout() {
  const source = editingLayout();
  const copy = duplicateLayout(source, `${source.name} copy`);
  layouts.push(copy);
  persistLayouts();
  editingLayoutId = copy.id;
  setEditingLayoutId(copy.id);
  capture = null;
  render(); // players panel needs the new layout in its assignment dropdowns
  el.layoutName.focus();
  el.layoutName.select();
  toast(`Duplicated "${source.name}"`);
}

function deleteLayout() {
  if (layouts.length <= 1) return;
  const removed = editingLayout();
  if (!confirm(`Delete layout "${removed.name}"?`)) return;

  layouts = layouts.filter((l) => l.id !== removed.id);
  persistLayouts();

  // Unassign anyone who was on it; they fall back to a blank screen.
  const affected: string[] = [];
  for (const [userId, config] of Object.entries(players)) {
    if (config.layoutId === removed.id) {
      config.layoutId = null;
      affected.push(userId);
    }
  }
  savePlayers(players);

  editingLayoutId = layouts[0].id;
  setEditingLayoutId(editingLayoutId);
  capture = null;
  render();
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
    render();
    return;
  }
  if (MODIFIER_CODES.has(e.code)) return; // hold for the main key

  const modifiers: Modifier[] = [];
  if (e.ctrlKey) modifiers.push("Control");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");
  if (e.metaKey) modifiers.push("Meta");
  // Keep modifiers in a stable, canonical order.
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  const binding: Binding = { modifiers: ordered, code: e.code };

  if (capture.kind === "default") {
    const button = editingLayout().buttons.find((b) => b.id === capture!.buttonId);
    if (button) {
      button.binding = binding;
      persistLayouts();
    }
  } else {
    ensurePlayer(capture.userId).overrides[capture.buttonId] = binding;
    savePlayers(players);
  }

  capture = null;
  render();
});

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

// `apiBase` is the HTTP front door, e.g. "https://app.hackbox.ca/api".
async function ensureRoom(apiBase: string): Promise<string> {
  const existing = localStorage.getItem(LS.roomCode);
  if (existing) {
    try {
      const res = await fetch(
        `${apiBase}/rooms/${existing}?userId=${encodeURIComponent(hostId)}`,
      );
      const data = await res.json();
      if (data.exists) return existing;
    } catch {
      /* fall through to create */
    }
  }

  const res = await fetch(`${apiBase}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostId }),
  });
  const data = await res.json();
  if (!data.ok || !data.roomCode) {
    throw new Error(data.error || "Failed to create room");
  }
  localStorage.setItem(LS.roomCode, data.roomCode);
  return data.roomCode;
}

// Push a player's current state: their assigned layout, or a blank screen if
// they have none. Re-pushing a layout also resets each button's "submitted"
// lock so presses are repeatable.
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
    localStorage.removeItem(LS.roomCode); // force a fresh room
    void connect();
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
    roomCode = await ensureRoom(API_BASE);
  } catch (err) {
    setStatus("offline", `Room error: ${(err as Error).message}`);
    scheduleRecreate(); // retry shortly; no manual reconnect button
    return;
  }

  el.roomCode.textContent = roomCode;

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
      if (m.online && !initialized.has(m.id)) {
        initialized.add(m.id);
        // Push their saved assignment (blank if none / first time).
        pushToPlayer(m.id);
      }
      if (!m.online) initialized.delete(m.id);
    }
    renderPlayers();
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
      // Re-arm the player's buttons (clears the tapped button's submitted lock).
      pushToPlayer(from);
    }
    flashPlayer(from);
  });
}

// Discard the current room and spin up a fresh one. The room is reused across
// relaunches (ensureRoom reuses the stored code), so this is the only way to
// rotate the code on demand. Existing players will need the new code to rejoin.
async function newRoom() {
  el.newRoomBtn.disabled = true;
  localStorage.removeItem(LS.roomCode); // force ensureRoom to allocate a fresh code
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

async function doExport() {
  const layout = editingLayout();
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
    editingLayoutId = layout.id;
    setEditingLayoutId(layout.id);
    capture = null;
    render();
    toast(`Imported "${layout.name}"`);
    return true;
  } catch (err) {
    el.importError.textContent = (err as Error).message;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wire up DOM events
// ---------------------------------------------------------------------------

el.newRoomBtn.addEventListener("click", () => void newRoom());
el.layoutSelect.addEventListener("change", () => selectEditingLayout(el.layoutSelect.value));
el.newLayoutBtn.addEventListener("click", () => createLayout());
el.layoutName.addEventListener("input", () => {
  editingLayout().name = el.layoutName.value;
  persistLayouts();
  // Reflect the rename in the picker + every player's assignment dropdown
  // without disturbing the focused input.
  const label = el.layoutName.value || "Untitled";
  for (const opt of document.querySelectorAll<HTMLOptionElement>(
    `option[value="${CSS.escape(editingLayoutId)}"]`,
  )) {
    opt.textContent = label;
  }
});
el.addButtonBtn.addEventListener("click", () => addButton());
el.duplicateLayoutBtn.addEventListener("click", () => duplicateCurrentLayout());
el.exportBtn.addEventListener("click", () => void doExport());
el.importBtn.addEventListener("click", () => openImport());
el.deleteLayoutBtn.addEventListener("click", () => deleteLayout());

el.importFile.addEventListener("change", async () => {
  const file = el.importFile.files?.[0];
  if (file) el.importText.value = await file.text();
});

// Validate before closing so a bad paste keeps the dialog open with the error.
el.importConfirm.addEventListener("click", (e) => {
  e.preventDefault();
  if (applyImport(el.importText.value)) el.importDialog.close("import");
});

// Create/reuse a room and connect immediately on launch.
render();
void connect();
