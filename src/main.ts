import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { initStorage, storage } from "./storage";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { emptyState, layoutState } from "./memberState";
import { createHackboxSocket, type HackboxSocket } from "./hackboxSocket";
import {
  decodeBinding,
  duplicateLayout,
  encodeBinding,
  exportLayout,
  getEditingLayoutId,
  importLayout,
  loadLayouts,
  loadPlayers,
  MODIFIER_ORDER,
  newButton,
  newLayout,
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

const LS = {
  hostId: "h2k.hostId",
  playerOrder: "h2k.playerOrder",
} as const;

const SERVER_URL = "https://hackbox.ca";
const API_BASE = `${new URL(SERVER_URL).origin}/api`;
const RELAY_HOST = new URL(SERVER_URL).host;
const RELAY_PROTOCOL = new URL(SERVER_URL).protocol === "https:" ? "wss" : "ws";

function getHostId(): string {
  let id = storage.getItem(LS.hostId);
  if (!id) {
    id = crypto.randomUUID();
    storage.setItem(LS.hostId, id);
  }
  return id;
}

let hostId = "";

interface Member {
  id: string;
  name: string;
  online: boolean;
}

let layouts: Layout[] = [];
let editingLayoutId: string | null = null;
let players: Players = {};
let playerOrder: string[] = [];

function loadPlayerOrder(): string[] {
  try {
    const raw = JSON.parse(storage.getItem(LS.playerOrder) || "[]");
    return Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function savePlayerOrder() {
  storage.setItem(LS.playerOrder, JSON.stringify(playerOrder));
}

function orderedMembers(): Member[] {
  const all = Object.values(members);
  const known = new Set(playerOrder);
  const newcomers = all
    .filter((m) => !known.has(m.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (newcomers.length) {
    playerOrder = [...playerOrder, ...newcomers.map((m) => m.id)];
    savePlayerOrder();
  }
  const rank = new Map(playerOrder.map((id, i) => [id, i]));
  return all.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

let socket: HackboxSocket | null = null;
let members: Record<string, Member> = {};
const initialized = new Set<string>();
const joinedThisRoom = new Set<string>();

type View = "players" | "layouts" | "editor";
let currentView: View = "players";

type CaptureTarget =
  | { kind: "default"; buttonId: string }
  | { kind: "playerKey"; buttonId: string }
  | { kind: "player"; userId: string; buttonId: string };
let capture: CaptureTarget | null = null;

function editingLayout(): Layout | undefined {
  return editingLayoutId
    ? layouts.find((l) => l.id === editingLayoutId)
    : undefined;
}

function layoutById(id: string | null | undefined): Layout | undefined {
  return id ? layouts.find((l) => l.id === id) : undefined;
}

function assignedLayout(userId: string): Layout | undefined {
  return layoutById(players[userId]?.layoutId);
}

function ensurePlayer(userId: string): PlayerConfig {
  return (players[userId] ||= { layoutId: null, overrides: {} });
}

function persistLayouts() {
  saveLayouts(layouts);
}

function effectiveBinding(userId: string, button: ButtonDef): Binding | null {
  return players[userId]?.overrides[button.id] ?? button.binding;
}

const el = {
  viewPlayers: document.getElementById("view-players") as HTMLDivElement,
  viewLayouts: document.getElementById("view-layouts") as HTMLDivElement,
  viewEditor: document.getElementById("view-editor") as HTMLDivElement,
  roomCode: document.getElementById("room-code") as HTMLSpanElement,
  newRoomBtn: document.getElementById("new-room-btn") as HTMLButtonElement,
  statusDot: document.getElementById("status-dot") as HTMLSpanElement,
  tabPlayers: document.getElementById("tab-players") as HTMLButtonElement,
  tabLayouts: document.getElementById("tab-layouts") as HTMLButtonElement,
  playerList: document.getElementById("player-list") as HTMLUListElement,
  emptyHint: document.getElementById("empty-hint") as HTMLParagraphElement,
  newLayoutBtn: document.getElementById("new-layout-btn") as HTMLButtonElement,
  importBtn: document.getElementById("import-btn") as HTMLButtonElement,
  layoutIndex: document.getElementById("layout-index") as HTMLUListElement,
  layoutsEmptyHint: document.getElementById(
    "layouts-empty-hint",
  ) as HTMLParagraphElement,
  editorBack: document.getElementById("editor-back") as HTMLButtonElement,
  layoutName: document.getElementById("layout-name") as HTMLInputElement,
  layoutButtons: document.getElementById("layout-buttons") as HTMLUListElement,
  addButtonBtn: document.getElementById("add-button-btn") as HTMLButtonElement,
  confirmDialog: document.getElementById("confirm-dialog") as HTMLDialogElement,
  confirmTitle: document.getElementById("confirm-title") as HTMLHeadingElement,
  confirmMessage: document.getElementById(
    "confirm-message",
  ) as HTMLParagraphElement,
  confirmOk: document.getElementById("confirm-ok") as HTMLButtonElement,
  toast: document.getElementById("toast") as HTMLDivElement,
};

function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
}): Promise<boolean> {
  el.confirmTitle.textContent = opts.title;
  el.confirmMessage.textContent = opts.message;
  el.confirmOk.textContent = opts.confirmLabel;
  el.confirmOk.className =
    opts.tone === "primary" ? "primary-btn" : "ghost-btn danger";
  el.confirmDialog.showModal();
  return new Promise((resolve) => {
    el.confirmDialog.addEventListener(
      "close",
      () => resolve(el.confirmDialog.returnValue === "confirm"),
      { once: true },
    );
  });
}

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

function showView(view: View) {
  if (view !== currentView) capture = null;
  currentView = view;
  el.viewPlayers.hidden = view !== "players";
  el.viewLayouts.hidden = view !== "layouts";
  el.viewEditor.hidden = view !== "editor";

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

function bindingLabel(b: Binding): string {
  return [...b.modifiers.map((m) => MOD_LABEL[m]), keyLabel(b.code)].join("+");
}

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

  const edit = iconButton("✎", "Edit layout");
  edit.addEventListener("click", () => openEditor(layout.id));

  const dup = iconButton("⧉", "Duplicate layout");
  dup.addEventListener("click", () => duplicateLayoutById(layout.id));

  const exp = iconButton("⤓", "Export layout to a JSON file");
  exp.addEventListener("click", () => void exportLayoutFile(layout));

  const del = iconButton("×", "Delete layout", true);
  del.addEventListener("click", () => void deleteLayout(layout.id));

  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.append(edit, dup, exp, del);

  li.append(grip, meta, actions);
  wireRowDrag(li, grip, commitIndexOrder);
  return li;
}

function iconButton(
  glyph: string,
  label: string,
  danger = false,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon-btn" + (danger ? " danger" : "");
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

function wireRowDrag(
  li: HTMLLIElement,
  grip: HTMLElement,
  onCommit: () => void,
) {
  const disarm = () => {
    li.draggable = false;
  };
  grip.addEventListener("mousedown", () => {
    li.draggable = true;
  });
  grip.addEventListener("mouseup", disarm);

  li.addEventListener("dragstart", (e) => {
    li.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", li.dataset.id || "");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    disarm();
    onCommit();
  });
}

function wireContainerDrag(container: HTMLElement, rowSelector: string) {
  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const dragging = container.querySelector(".dragging") as HTMLElement | null;
    if (!dragging) return;
    const after = dragAfterElement(container, e.clientY, rowSelector);
    if (after == null) container.appendChild(dragging);
    else container.insertBefore(dragging, after);
  });
  container.addEventListener("drop", (e) => e.preventDefault());
}

wireContainerDrag(el.layoutIndex, ".layout-index-row");
wireContainerDrag(el.playerList, ".player");

function dragAfterElement(
  container: HTMLElement,
  y: number,
  rowSelector: string,
): HTMLElement | null {
  const rows = [
    ...container.querySelectorAll<HTMLElement>(`${rowSelector}:not(.dragging)`),
  ];
  let closest: { offset: number; element: HTMLElement | null } = {
    offset: Number.NEGATIVE_INFINITY,
    element: null,
  };
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset)
      closest = { offset, element: row };
  }
  return closest.element;
}

function commitIndexOrder() {
  const order = [
    ...el.layoutIndex.querySelectorAll<HTMLElement>(".layout-index-row"),
  ].map((li) => li.dataset.id);
  const byId = new Map(layouts.map((l) => [l.id, l]));
  const reordered = order
    .map((id) => byId.get(id!))
    .filter(Boolean) as Layout[];
  if (reordered.length !== layouts.length) return;
  const changed = reordered.some((l, i) => l.id !== layouts[i].id);
  if (!changed) return;
  layouts = reordered;
  persistLayouts();
}

function commitPlayerOrder() {
  const ids = [...el.playerList.querySelectorAll<HTMLElement>(".player")]
    .map((li) => li.dataset.id)
    .filter((id): id is string => !!id);
  const shown = new Set(ids);
  playerOrder = [...ids, ...playerOrder.filter((id) => !shown.has(id))];
  savePlayerOrder();
}

function renderEditor() {
  const layout = editingLayout();
  if (!layout) {
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

  const keys = document.createElement("div");
  keys.className = "lbr-keys";

  const playerCapturing =
    capture?.kind === "playerKey" && capture.buttonId === button.id;
  const playerField = document.createElement("div");
  playerField.className = "lbr-key";
  const playerLbl = document.createElement("span");
  playerLbl.className = "lbr-key-label";
  playerLbl.textContent = "Player presses";
  const playerBtn = document.createElement("button");
  playerBtn.className = `key-btn${playerCapturing ? " capturing" : ""}${button.playerKey ? "" : " unset"}`;
  playerBtn.textContent = playerCapturing
    ? "Press a key…"
    : button.playerKey
      ? playerKeyLabel(button.playerKey)
      : "Tap only";
  playerBtn.title =
    "Key the player presses on their OWN device to fire this button";
  playerBtn.addEventListener("click", () => {
    capture = playerCapturing
      ? null
      : { kind: "playerKey", buttonId: button.id };
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

  const hostCapturing =
    capture?.kind === "default" && capture.buttonId === button.id;
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

function renderPlayers() {
  const list = orderedMembers();
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

  const head = document.createElement("div");
  head.className = "player-head";
  head.innerHTML = `
    <span class="player-dot ${member.online ? "online" : "offline"}"></span>
    <span class="player-name">${escapeHtml(member.name)}</span>
  `;

  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = "⠿";
  grip.title = "Drag to reorder";
  head.prepend(grip);

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

  const layout = assignedLayout(member.id);
  if (layout && layout.buttons.length) {
    const grid = document.createElement("div");
    grid.className = "player-bindings";
    for (const button of layout.buttons) {
      grid.appendChild(renderPlayerBinding(member, button));
    }
    li.appendChild(grid);
  }

  wireRowDrag(li, grip, commitPlayerOrder);
  return li;
}

function renderPlayerBinding(
  member: Member,
  button: ButtonDef,
): HTMLDivElement {
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
  keyBtn.dataset.buttonId = button.id;
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
  void (li as HTMLElement).offsetWidth;
  li.classList.add("hit");
}

function flashButton(userId: string, buttonId: string) {
  const btn = el.playerList.querySelector<HTMLElement>(
    `li[data-id="${CSS.escape(userId)}"] .bind-btn[data-button-id="${CSS.escape(buttonId)}"]`,
  );
  if (!btn) return;
  btn.classList.remove("hit");
  void btn.offsetWidth;
  btn.classList.add("hit");
}

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
  for (const config of Object.values(players))
    delete config.overrides[buttonId];
  persistLayouts();
  savePlayers(players);
  renderEditor();
  void pushLayoutToAssigned(layout.id);
}

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
  const layout = newLayout(`Layout ${layouts.length + 1}`);
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
  if (MODIFIER_CODES.has(e.code)) return;

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
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  const binding: Binding = { modifiers: ordered, code: e.code };

  if (capture.kind === "default") {
    const button = editingLayout()?.buttons.find(
      (b) => b.id === capture!.buttonId,
    );
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

function rerenderCaptureView() {
  if (currentView === "editor") renderEditor();
  else renderPlayers();
}

async function pressKey(b: Binding) {
  try {
    await invoke("press_key", { code: b.code, modifiers: b.modifiers });
  } catch (err) {
    console.error("press_key failed", err);
  }
}

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

function pushToPlayer(userId: string) {
  if (!socket) return;
  const name = members[userId]?.name || "";
  const layout = assignedLayout(userId);
  socket.emit("member.update", {
    to: userId,
    data: layout
      ? layoutState(name, layout, (b) => effectiveBinding(userId, b))
      : emptyState(name),
  });
}

function pushLayoutToAssigned(layoutId: string) {
  if (!socket) return;
  for (const m of Object.values(members)) {
    if (m.online && players[m.id]?.layoutId === layoutId) pushToPlayer(m.id);
  }
}

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

const TRANSIENT_REASONS = new Set(["transport close", "transport error"]);
let recreateTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRecreate() {
  if (recreateTimer !== null) return;
  recreateTimer = setTimeout(() => {
    recreateTimer = null;
    void connect();
  }, 3000);
}

async function connect() {
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
    scheduleRecreate();
    return;
  }

  el.roomCode.textContent = roomCode;

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
      setStatus("connecting", "Reconnecting…");
      return;
    }
    setStatus("offline", `Disconnected: ${r}`);
    scheduleRecreate();
  });

  socket.on("error", (payload) => {
    const message = (payload as { message?: string })?.message;
    setStatus("offline", message || "Server error");
  });

  socket.on("state.host", (payload) => {
    members = (payload as { members?: Record<string, Member> }).members || {};
    for (const m of Object.values(members)) {
      if (m.online) {
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

  socket.on("msg", (payload) => {
    const p = payload as { from?: string; value?: string };
    const from = p?.from;
    if (!from) return;
    const binding = decodeBinding(p.value);
    if (binding) void pressKey(binding);
    const layout = assignedLayout(from);
    const button = layout?.buttons.find(
      (b) => encodeBinding(effectiveBinding(from, b)) === p.value,
    );
    if (button) flashButton(from, button.id);
    flashPlayer(from);
  });
}

async function newRoom() {
  el.newRoomBtn.disabled = true;
  members = {};
  initialized.clear();
  el.roomCode.textContent = "————";
  renderPlayers();
  await connect();
  el.newRoomBtn.disabled = false;
}

async function exportLayoutFile(layout: Layout) {
  const safeName = (layout.name || "layout").replace(/[^a-z0-9-_]+/gi, "-");
  const path = await save({
    defaultPath: `${safeName}.hackboxkb.json`,
    filters: [{ name: "Hackbox Layout", extensions: ["json"] }],
  });
  if (!path) return;
  try {
    await writeTextFile(path, exportLayout(layout));
    toast("Layout exported");
  } catch (err) {
    toast(`Export failed: ${(err as Error).message}`);
  }
}

async function openImport() {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Hackbox Layout", extensions: ["json"] }],
  });
  if (typeof path !== "string") return;
  let json: string;
  try {
    json = await readTextFile(path);
  } catch (err) {
    toast(`Couldn't read that file: ${(err as Error).message}`);
    return;
  }
  applyImport(json);
}

function applyImport(json: string) {
  try {
    const layout = importLayout(json);
    layouts.push(layout);
    persistLayouts();
    toast(`Imported "${layout.name}"`);
    openEditor(layout.id);
  } catch (err) {
    toast((err as Error).message);
  }
}

el.newRoomBtn.addEventListener("click", () => void newRoom());
el.tabPlayers.addEventListener("click", () => showView("players"));
el.tabLayouts.addEventListener("click", () => showView("layouts"));

el.newLayoutBtn.addEventListener("click", () => createLayout());
el.importBtn.addEventListener("click", () => void openImport());

el.editorBack.addEventListener("click", () => showView("layouts"));
el.layoutName.addEventListener("input", () => {
  const layout = editingLayout();
  if (layout) {
    layout.name = el.layoutName.value;
    persistLayouts();
  }
});
el.addButtonBtn.addEventListener("click", () => addButton());

async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;

    const ok = await confirmDialog({
      title: "Update available",
      message: `Version ${update.version} is available (you have ${update.currentVersion}). Install it now? The app will restart.`,
      confirmLabel: "Install & restart",
      tone: "primary",
    });
    if (!ok) return;

    toast("Downloading update…");
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.warn("Update check failed:", err);
  }
}

async function bootstrap() {
  await initStorage();
  hostId = getHostId();
  layouts = loadLayouts();
  editingLayoutId = getEditingLayoutId();
  players = loadPlayers();
  playerOrder = loadPlayerOrder();

  showView("players");
  void connect();
  void checkForUpdates();
}
void bootstrap();
