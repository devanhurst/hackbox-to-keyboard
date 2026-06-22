import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "app-data.json";
const MIGRATED_FLAG = "h2k.migratedFromLocalStorage";

const LEGACY_KEYS = [
  "h2k.layouts",
  "h2k.editingLayoutId",
  "h2k.players",
  "h2k.bindings",
  "h2k.hostId",
  "h2k.playerOrder",
];

let store: Store;
const cache = new Map<string, string>();

export async function initStorage(): Promise<void> {
  store = await load(STORE_FILE, { autoSave: 100, defaults: {} });

  for (const [key, value] of await store.entries()) {
    if (typeof value === "string") cache.set(key, value);
  }

  await migrateFromLocalStorage();
}

async function migrateFromLocalStorage(): Promise<void> {
  if (cache.has(MIGRATED_FLAG)) return;

  if (typeof localStorage !== "undefined") {
    for (const key of LEGACY_KEYS) {
      const value = localStorage.getItem(key);
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
