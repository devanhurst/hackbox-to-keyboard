import PartySocket from "partysocket";

const PING_INTERVAL_MS = 25_000;
const KEEPALIVE_PING = "ping";
const WS_OPEN = 1;

const RELAY_PATH_PREFIX = "r";

const FATAL_CLOSE_THRESHOLD = 4000;

export interface HackboxSocketOptions {
  protocol: "ws" | "wss";
  host: string;
  roomCode: string;
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
    if (event.data === "pong") return;

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
      socket.close();
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
