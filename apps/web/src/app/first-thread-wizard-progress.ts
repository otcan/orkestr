// Remembers the first-run wizard's step and answers for this browser tab, so
// opening Setup from the wizard and coming back does not start over. No
// Angular imports, so tests can load it directly.

export interface WizardProgress {
  stepIndex: number;
  threadName: string;
  repoUrl: string;
  runtimeProvider: "codex" | "claude-code";
  whatsappAccessMode: "managed" | "self_hosted";
  whatsappModeTouched: boolean;
  savedAt: number;
}

const key = "orkestr:first-run-wizard";
const maxAgeMs = 24 * 60 * 60_000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

export function loadWizardProgress(store: StorageLike | null = storage(), now = Date.now()): WizardProgress | null {
  try {
    const value = JSON.parse(store?.getItem(key) || "null");
    if (!value || typeof value !== "object") return null;
    if (!Number.isFinite(value.savedAt) || now - value.savedAt > maxAgeMs) return null;
    return {
      stepIndex: Math.max(0, Math.floor(Number(value.stepIndex) || 0)),
      threadName: String(value.threadName || ""),
      repoUrl: String(value.repoUrl || ""),
      runtimeProvider: value.runtimeProvider === "claude-code" ? "claude-code" : "codex",
      whatsappAccessMode: value.whatsappAccessMode === "managed" ? "managed" : "self_hosted",
      whatsappModeTouched: value.whatsappModeTouched === true,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

export function saveWizardProgress(progress: Omit<WizardProgress, "savedAt">, store: StorageLike | null = storage(), now = Date.now()): void {
  try {
    store?.setItem(key, JSON.stringify({ ...progress, savedAt: now }));
  } catch {
    // Storage can be unavailable; the wizard then simply starts over.
  }
}

export function clearWizardProgress(store: StorageLike | null = storage()): void {
  try {
    store?.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}
