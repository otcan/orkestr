// Browser-local persistence. Data is kept in localStorage on this device only;
// if storage is unavailable the log still works for the open tab.
import { emptyLog, parseLog } from "./progression.js";

export const STORAGE_KEY = "orkestr.free.workoutLog.v1";

export function createStore(storage = safeStorage()) {
  let log = load(storage);

  function load(target) {
    if (!target) return emptyLog();
    try {
      const text = target.getItem(STORAGE_KEY);
      return text ? parseLog(JSON.parse(text)).log : emptyLog();
    } catch {
      return emptyLog();
    }
  }

  return {
    persistent: Boolean(storage),
    get log() {
      return log;
    },
    save(next) {
      log = next;
      if (!storage) return true;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(log));
        return true;
      } catch {
        return false;
      }
    },
    reload() {
      log = load(storage);
      return log;
    },
    clear() {
      log = emptyLog();
      if (storage) {
        try {
          storage.removeItem(STORAGE_KEY);
        } catch {
          return false;
        }
      }
      return true;
    },
  };
}

function safeStorage() {
  try {
    const storage = globalThis.localStorage;
    const probe = `${STORAGE_KEY}.probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
