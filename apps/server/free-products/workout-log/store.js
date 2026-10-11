// Browser-local persistence. Data is kept in localStorage on this device only;
// if storage is unavailable the log still works for the open tab.
import { emptyLog, parseLog } from "./progression.js";

export const STORAGE_KEY = "orkestr.free.workoutLog.v1";
export const TIMER_KEY = `${STORAGE_KEY}.restEndsAt`;

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
    // All-or-nothing: if the browser refuses the write, the previous log stays
    // both in memory and in storage.
    save(next) {
      if (storage) {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          return false;
        }
      }
      log = next;
      return true;
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
          storage.removeItem(TIMER_KEY);
        } catch {
          return false;
        }
      }
      return true;
    },
    // The rest timer end time survives a reload so an interrupted rest resumes.
    loadTimer() {
      const value = Number(storage?.getItem(TIMER_KEY));
      return Number.isFinite(value) && value > 0 ? value : 0;
    },
    saveTimer(endsAt) {
      try {
        if (endsAt) storage?.setItem(TIMER_KEY, String(Math.round(endsAt)));
        else storage?.removeItem(TIMER_KEY);
      } catch {
        // Losing the timer on reload is acceptable; the log itself is unaffected.
      }
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
