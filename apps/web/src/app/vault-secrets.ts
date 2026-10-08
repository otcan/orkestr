// Client-side helpers for the Vault page. Nothing in here logs or persists
// secret values; callers hold them only as long as the UI needs them.

export const vaultSecretTtlMs = 30_000;

export interface PasswordCharsets {
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
}

export const passwordCharsetChars: Record<keyof PasswordCharsets, string> = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?",
};

export const passwordMinLength = 12;
export const passwordMaxLength = 64;
export const passwordDefaultLength = 24;

type RandomFill = (array: Uint32Array) => Uint32Array;

function defaultRandomFill(array: Uint32Array): Uint32Array {
  return globalThis.crypto.getRandomValues(array);
}

// Unbiased index in [0, max) using rejection sampling over 32-bit values.
function randomIndex(max: number, fill: RandomFill): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    fill(buffer);
    if (buffer[0] < limit) return buffer[0] % max;
  }
}

export function generatePassword(length: number, charsets: PasswordCharsets, fill: RandomFill = defaultRandomFill): string {
  const size = Math.min(passwordMaxLength, Math.max(passwordMinLength, Math.floor(Number(length) || passwordDefaultLength)));
  const groups = (Object.keys(passwordCharsetChars) as Array<keyof PasswordCharsets>)
    .filter((key) => charsets[key])
    .map((key) => passwordCharsetChars[key]);
  if (!groups.length) groups.push(passwordCharsetChars.lower);
  const alphabet = groups.join("");
  // One character from every selected set, the rest from the full alphabet.
  const chars = groups.map((group) => group[randomIndex(group.length, fill)]);
  while (chars.length < size) chars.push(alphabet[randomIndex(alphabet.length, fill)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1, fill);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function isVaultReauthRequired(error: unknown): boolean {
  const value = error as { status?: number; error?: { error?: string } } | null;
  return value?.status === 401 && value?.error?.error === "vault_reauth_required";
}

export function vaultReauthUrl(location: { pathname?: string; search?: string; hash?: string } | undefined = globalThis.location): string {
  const current = `${location?.pathname || "/"}${location?.search || ""}${location?.hash || ""}`;
  return `/auth/login?return=${encodeURIComponent(current)}`;
}

export function vaultErrorMessage(error: unknown, fallback = "Vault request failed."): string {
  const value = error as { error?: { error?: string; message?: string } | string; message?: string } | null;
  const body = value?.error;
  if (body && typeof body === "object") return String(body.message || body.error || fallback);
  if (typeof body === "string" && body.length < 200) return body;
  return fallback;
}

// Copies a value and, after the TTL, clears the clipboard if it still holds
// the same value. Reading the clipboard can be denied; that is best effort.
export async function copySecret(value: string, clearAfterMs = vaultSecretTtlMs): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) return false;
  await clipboard.writeText(value);
  if (clearAfterMs > 0) {
    globalThis.setTimeout(() => void clearClipboardIfUnchanged(value), clearAfterMs);
  }
  return true;
}

export async function clearClipboardIfUnchanged(value: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.readText) return false;
    const current = await clipboard.readText();
    if (current !== value) return false;
    await clipboard.writeText("");
    return true;
  } catch {
    return false;
  }
}

interface DetectedBarcode { rawValue?: string }
interface BarcodeDetectorLike { detect(source: unknown): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

export function qrScanSupported(): boolean {
  return !!barcodeDetectorCtor() && typeof globalThis.createImageBitmap === "function";
}

export function cameraScanSupported(): boolean {
  return qrScanSupported() && typeof globalThis.navigator?.mediaDevices?.getUserMedia === "function";
}

// Returns every otpauth:// or otpauth-migration:// payload found in the source.
export async function scanQrCodes(source: Blob | HTMLVideoElement): Promise<string[]> {
  const Ctor = barcodeDetectorCtor();
  if (!Ctor) return [];
  const detector = new Ctor({ formats: ["qr_code"] });
  const target = source instanceof Blob ? await globalThis.createImageBitmap(source) : source;
  try {
    const found = await detector.detect(target);
    return found
      .map((code) => String(code.rawValue || "").trim())
      .filter((value) => /^otpauth(-migration)?:\/\//i.test(value));
  } finally {
    if (target && "close" in target && typeof target.close === "function") target.close();
  }
}
