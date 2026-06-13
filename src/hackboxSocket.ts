import PartySocket from "partysocket";

// Host-side connection to the hackbox relay (a Cloudflare Durable Object that
// speaks raw WebSocket via partysocket). Ported from the hackbox client SDK
// (client/src/lib/sockets/hackboxSocket.ts on the hackbox repo) and trimmed to
// what a host needs.
//
// Wire protocol: every frame is a JSON envelope `{ type, payload }`.
//   emit(type, payload)  -> sends { type, payload }
//   on(type, cb)         -> dispatches payload of matching incoming frames
//
// Host event surface:
//   receive: state.host { members }, msg { from, ... }, change { ... },
//            error { message }, disconnect <reason>
//   send:    member.update { to, data }, reload
//
// A socket whose userId equals the room's hostId is treated as the host by the
// relay — same contract as the legacy socket.io server.

// Browsers never send WebSocket pings and partysocket has no heartbeat, so an
// idle socket gets dropped by NAT/CGNAT idle timeouts (code 1006 ~60-90s in).
// The relay answers this keepalive at the edge (setWebSocketAutoResponse) so
// the DO stays hibernated. String must match the relay's auto-response pair.
const PING_INTERVAL_MS = 25_000;
const KEEPALIVE_PING = "ping";
const WS_OPEN = 1;

// The relay lives at <host>/r/<code> — a single static path prefix on the apex.
const RELAY_PATH_PREFIX = "r";

// Close codes >= 4000 are deliberate server rejections (room gone/closed/
// expired, twitch required, duplicate device): do NOT reconnect. An `error`
// frame with a human message precedes the close.
const FATAL_CLOSE_THRESHOLD = 4000;

export interface HackboxSocketOptions {
  /** Relay protocol, derived from the configured URL scheme. */
  protocol: "ws" | "wss";
  /** Relay host[:port], no protocol/path (e.g. "app.hackbox.ca"). */
  host: string;
  /** 4-character room code. */
  roomCode: string;
  /** The room's hostId — connecting with it joins as the host. */
  userId: string;
}

type Listener = (payload: unknown) => void;

export interface HackboxSocket {
  on(event: string, cb: Listener): () => void;
  off(event: string, cb: Listener): void;
  emit(event: string, payload?: unknown): void;
  close(): void;
  readonly connected: boolean;
}

export function createHackboxSocket(options: HackboxSocketOptions): HackboxSocket {
  const listeners = new Map<string, Set<Listener>>();

  const emitLocal = (event: string, payload?: unknown) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[hackbox] listener for "${event}" threw`, err);
      }
    }
  };

  const roomCode = options.roomCode.toUpperCase();
  const socket = new PartySocket({
    protocol: options.protocol,
    host: options.host,
    room: roomCode,
    // Override partysocket's default `<prefix>/<party>/<room>` path with the
    // minimal `<host>/r/<code>` the relay routes.
    basePath: `${RELAY_PATH_PREFIX}/${roomCode}`,
    query: {
      userId: options.userId,
      userName: "",
      metadata: "{}",
    },
    minReconnectionDelay: 250,
    maxReconnectionDelay: 1000,
    reconnectionDelayGrowFactor: 2,
  });

  let fatal = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const stopPing = () => {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  socket.addEventListener("open", () => {
    stopPing();
    pingTimer = setInterval(() => {
      if (socket.readyState === WS_OPEN) socket.send(KEEPALIVE_PING);
    }, PING_INTERVAL_MS);
    emitLocal("connect");
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    if (event.data === "pong") return; // keepalive auto-response

    let frame: { type?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;

    emitLocal(frame.type, frame.payload);
  });

  socket.addEventListener("close", (event: CloseEvent) => {
    stopPing();
    if (event.code >= FATAL_CLOSE_THRESHOLD) {
      fatal = true;
      socket.close(); // halt partysocket's auto-reconnect
      emitLocal("disconnect", event.reason || "server disconnect");
      return;
    }
    if (fatal) return;
    emitLocal("disconnect", "transport close");
  });

  socket.addEventListener("error", () => {
    if (fatal) return;
    emitLocal("disconnect", "transport error");
  });

  return {
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    },
    off(event, cb) {
      listeners.get(event)?.delete(cb);
    },
    emit(event, payload) {
      socket.send(JSON.stringify({ type: event, payload }));
    },
    close() {
      fatal = true;
      stopPing();
      socket.close();
    },
    get connected() {
      return socket.readyState === WS_OPEN;
    },
  };
}
