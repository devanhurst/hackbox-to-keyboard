import { io, type Socket } from "socket.io-client";
import { invoke } from "@tauri-apps/api/core";
import { buttonState } from "./memberState";

// ---------------------------------------------------------------------------
// Persistent identity + config
//
// The server treats any socket whose handshake `userId` equals the room's
// `hostId` as the host (see server RoomService.joinRoom). So we persist a
// stable hostId, create/reuse a room owned by it, and connect with it.
// ---------------------------------------------------------------------------

const LS = {
  hostId: "h2k.hostId",
  serverUrl: "h2k.serverUrl",
  roomCode: "h2k.roomCode",
  bindings: "h2k.bindings",
} as const;

const DEFAULT_SERVER = "https://app.hackbox.ca";

function getHostId(): string {
  let id = localStorage.getItem(LS.hostId);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS.hostId, id);
  }
  return id;
}

const hostId = getHostId();

// A binding is a main key (KeyboardEvent.code, e.g. "KeyA") plus zero or more
// modifiers held down around it.
type Modifier = "Control" | "Alt" | "Shift" | "Meta";
interface Binding {
  modifiers: Modifier[];
  code: string;
}
// userId -> Binding
type Bindings = Record<string, Binding>;

const MODIFIER_ORDER: Modifier[] = ["Control", "Alt", "Shift", "Meta"];

function loadBindings(): Bindings {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(localStorage.getItem(LS.bindings) || "{}");
  } catch {
    return {};
  }
  const out: Bindings = {};
  for (const [id, v] of Object.entries(raw)) {
    // Migrate the old shape (plain "KeyA" string) to { modifiers, code }.
    if (typeof v === "string") {
      out[id] = { modifiers: [], code: v };
    } else if (v && typeof v === "object" && typeof (v as Binding).code === "string") {
      const b = v as Binding;
      out[id] = {
        code: b.code,
        modifiers: Array.isArray(b.modifiers)
          ? MODIFIER_ORDER.filter((m) => b.modifiers.includes(m))
          : [],
      };
    }
  }
  return out;
}

function saveBindings(b: Bindings) {
  localStorage.setItem(LS.bindings, JSON.stringify(b));
}

const bindings = loadBindings();

interface Member {
  id: string;
  name: string;
  online: boolean;
}

let socket: Socket | null = null;
let members: Record<string, Member> = {};
const initialized = new Set<string>(); // players we've pushed the button UI to
let capturingFor: string | null = null; // userId awaiting a key capture

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const el = {
  serverUrl: document.getElementById("server-url") as HTMLInputElement,
  roomCode: document.getElementById("room-code") as HTMLSpanElement,
  connectBtn: document.getElementById("connect-btn") as HTMLButtonElement,
  statusDot: document.getElementById("status-dot") as HTMLSpanElement,
  statusText: document.getElementById("status-text") as HTMLSpanElement,
  playerList: document.getElementById("player-list") as HTMLUListElement,
  emptyHint: document.getElementById("empty-hint") as HTMLParagraphElement,
};

el.serverUrl.value = localStorage.getItem(LS.serverUrl) || DEFAULT_SERVER;

function setStatus(state: "online" | "offline" | "connecting", text: string) {
  el.statusDot.className = `dot ${state}`;
  el.statusText.textContent = text;
}

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

function render() {
  const list = Object.values(members).sort((a, b) => a.name.localeCompare(b.name));
  el.emptyHint.style.display = list.length ? "none" : "block";
  el.playerList.innerHTML = "";

  for (const m of list) {
    const li = document.createElement("li");
    li.className = "player" + (m.online ? "" : " offline");
    li.dataset.id = m.id;

    const bound = bindings[m.id];
    const isCapturing = capturingFor === m.id;

    li.innerHTML = `
      <span class="player-dot ${m.online ? "online" : "offline"}"></span>
      <span class="player-name">${escapeHtml(m.name)}</span>
      <button class="bind-btn ${isCapturing ? "capturing" : ""} ${bound ? "" : "unset"}">
        ${isCapturing ? "Press keys…" : bound ? bindingLabel(bound) : "Set key"}
      </button>
    `;

    const bindBtn = li.querySelector(".bind-btn") as HTMLButtonElement;
    bindBtn.addEventListener("click", () => {
      capturingFor = capturingFor === m.id ? null : m.id;
      render();
    });

    el.playerList.appendChild(li);
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function flashPlayer(userId: string) {
  const li = el.playerList.querySelector(`li[data-id="${CSS.escape(userId)}"]`);
  if (!li) return;
  li.classList.remove("hit");
  void (li as HTMLElement).offsetWidth; // restart the CSS animation
  li.classList.add("hit");
}

// ---------------------------------------------------------------------------
// Key capture: bind the next physical key to the selected player
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
  if (!capturingFor) return;
  e.preventDefault();
  if (e.code === "Escape") {
    capturingFor = null;
    render();
    return;
  }
  if (MODIFIER_CODES.has(e.code)) return; // hold for the main key

  const modifiers: Modifier[] = [];
  if (e.ctrlKey) modifiers.push("Control");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");
  if (e.metaKey) modifiers.push("Meta");

  bindings[capturingFor] = { modifiers, code: e.code };
  saveBindings(bindings);
  capturingFor = null;
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

async function ensureRoom(serverUrl: string): Promise<string> {
  const existing = localStorage.getItem(LS.roomCode);
  if (existing) {
    try {
      const res = await fetch(
        `${serverUrl}/rooms/${existing}?userId=${encodeURIComponent(hostId)}`,
      );
      const data = await res.json();
      if (data.exists) return existing;
    } catch {
      /* fall through to create */
    }
  }

  const res = await fetch(`${serverUrl}/rooms`, {
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

// The single-button UI we hand each player. Re-pushing it resets the button's
// "submitted" lock so presses are repeatable.
function pushButton(userId: string, name: string) {
  socket?.emit("member.update", {
    to: userId,
    data: buttonState(name),
  });
}

async function connect() {
  const serverUrl = el.serverUrl.value.trim().replace(/\/$/, "") || DEFAULT_SERVER;
  localStorage.setItem(LS.serverUrl, serverUrl);

  setStatus("connecting", "Connecting…");
  el.connectBtn.disabled = true;

  let roomCode: string;
  try {
    roomCode = await ensureRoom(serverUrl);
  } catch (err) {
    setStatus("offline", `Room error: ${(err as Error).message}`);
    el.connectBtn.disabled = false;
    return;
  }

  el.roomCode.textContent = roomCode;

  socket?.disconnect();
  socket = io(serverUrl, {
    query: { userId: hostId, roomCode },
    transports: ["websocket"],
  });

  socket.on("connect", () => {
    setStatus("online", `Hosting ${roomCode}`);
    el.connectBtn.disabled = false;
    el.connectBtn.textContent = "Reconnect";
  });

  socket.on("disconnect", () => setStatus("offline", "Disconnected"));
  socket.on("connect_error", (e) => setStatus("offline", `Connection error: ${e.message}`));
  socket.on("error", (e: { message?: string }) =>
    setStatus("offline", e?.message || "Server error"),
  );

  // Roster updates: server sends the full member map each time it changes.
  socket.on("state.host", (state: { members: Record<string, Member> }) => {
    members = state.members || {};
    for (const m of Object.values(members)) {
      if (m.online && !initialized.has(m.id)) {
        initialized.add(m.id);
        pushButton(m.id, m.name);
      }
      if (!m.online) initialized.delete(m.id);
    }
    render();
  });

  // A player tapped their button.
  socket.on(
    "msg",
    (payload: { from: string; message?: { value?: string } }) => {
      if (!payload?.from) return;
      const binding = bindings[payload.from];
      if (binding) void pressKey(binding);
      flashPlayer(payload.from);
      // Re-arm the player's button (clears its submitted/disabled state).
      pushButton(payload.from, members[payload.from]?.name || "");
    },
  );
}

el.connectBtn.addEventListener("click", () => void connect());

// Auto-connect on launch if we already have a server configured.
if (localStorage.getItem(LS.serverUrl)) {
  void connect();
}

render();
