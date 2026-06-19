// ---------------------------------------------------------------------------
// Persistent storage.
//
// Backed by tauri-plugin-store: an inspectable JSON file in the app data dir
// (keyed by the bundle identifier), so it reliably survives app updates. The
// plugin's API is async, but the rest of the app reads/writes config
// synchronously at module load, so we expose a localStorage-shaped facade over
// an in-memory cache that's hydrated once at startup.
//
// Call initStorage() exactly once, before any getItem/setItem — main.ts awaits
// it at the top of the module (top-level await) so every later read is served
// from the hydrated cache.
// ---------------------------------------------------------------------------

import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "app-data.json";
const MIGRATED_FLAG = "h2k.migratedFromLocalStorage";

// Keys that previously lived in WebView localStorage; copied into the store on
// first run so upgrading users keep their layouts, players, and identity.
const LEGACY_KEYS = [
  "h2k.layouts",
  "h2k.editingLayoutId",
  "h2k.players",
  "h2k.bindings", // legacy single-button bindings, consumed by loadLayouts()
  "h2k.hostId",
  "h2k.playerOrder",
];

let store: Store;
const cache = new Map<string, string>();

export async function initStorage(): Promise<void> {
  // autoSave debounces a disk write after each mutation, so callers don't have
  // to flush explicitly on every setItem.
  store = await load(STORE_FILE, { autoSave: 100, defaults: {} });

  for (const [key, value] of await store.entries()) {
    if (typeof value === "string") cache.set(key, value);
  }

  await migrateFromLocalStorage();
}

// One-time migration of any existing WebView localStorage into the store.
async function migrateFromLocalStorage(): Promise<void> {
  if (cache.has(MIGRATED_FLAG)) return;

  if (typeof localStorage !== "undefined") {
    for (const key of LEGACY_KEYS) {
      const value = localStorage.getItem(key);
      // Never clobber a value already in the store.
      if (value !== null && !cache.has(key)) {
        cache.set(key, value);
        await store.set(key, value);
      }
    }
  }

  cache.set(MIGRATED_FLAG, "1");
  await store.set(MIGRATED_FLAG, "1");
  await store.save();
}

// localStorage-shaped facade. Reads hit the in-memory cache; writes update the
// cache synchronously and persist in the background (autoSave flushes to disk).
export const storage = {
  getItem(key: string): string | null {
    return cache.has(key) ? cache.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    cache.set(key, value);
    void store.set(key, value);
  },
  removeItem(key: string): void {
    cache.delete(key);
    void store.delete(key);
  },
};
