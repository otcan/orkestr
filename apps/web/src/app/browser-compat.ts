// Browser features that are missing on plain-HTTP pages that are not
// localhost (for example http://0.0.0.0:3000 or a LAN address).

// Copies text. navigator.clipboard only exists on secure pages, so fall back
// to selecting a hidden textarea and execCommand("copy"). Returns false if
// both fail, so the caller can show the text for manual copying.
export async function copyText(text: string): Promise<boolean> {
  return (await copyTextWith(text)) !== "";
}

// Which way the copy went: "clipboard-api" (can be read back and cleared
// later), "fallback" (copied, but cannot be cleared by the page) or "" (failed).
export async function copyTextWith(text: string): Promise<"clipboard-api" | "fallback" | ""> {
  try {
    if (globalThis.navigator?.clipboard?.writeText && globalThis.isSecureContext !== false) {
      await globalThis.navigator.clipboard.writeText(text);
      return "clipboard-api";
    }
  } catch {
    // Fall through to the textarea fallback.
  }
  const doc = globalThis.document;
  if (!doc?.body) return "";
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.left = "-1000px";
  doc.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = doc.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied ? "fallback" : "";
}

const unavailableMarker = "__orkestrWebCryptoUnavailable";

// Without WebCrypto (insecure pages), age-encryption throws a TypeError instead
// of using its pure-JavaScript X25519 code. A stand-in whose methods reject
// with NotSupportedError makes it take that fallback; code that really needs
// WebCrypto checks webCryptoAvailable().
export function installWebCryptoFallbackShim(): void {
  const cryptoObject = globalThis.crypto as (Crypto & Record<string, unknown>) | undefined;
  if (!cryptoObject || cryptoObject.subtle) return;
  const reject = () => Promise.reject(new DOMException("WebCrypto is unavailable on this page", "NotSupportedError"));
  const stub = new Proxy({ [unavailableMarker]: true }, {
    get: (target, property) => (property === unavailableMarker ? true : reject),
  });
  try {
    Object.defineProperty(cryptoObject, "subtle", { value: stub, configurable: true });
  } catch {
    // Leave crypto unchanged if the browser refuses.
  }
}

export function webCryptoAvailable(): boolean {
  const subtle = globalThis.crypto?.subtle as unknown as Record<string, unknown> | undefined;
  return Boolean(subtle) && subtle?.[unavailableMarker] !== true;
}

// 0.0.0.0 is what Docker listens on, but browsers treat http://0.0.0.0 as an
// insecure page (no clipboard, no WebCrypto, "Not secure" warning) while
// http://localhost is treated as secure. Same port, same server.
export function redirectZeroHostToLocalhost(): boolean {
  const location = globalThis.location;
  if (!location || location.hostname !== "0.0.0.0") return false;
  location.replace(`${location.protocol}//localhost${location.port ? `:${location.port}` : ""}${location.pathname}${location.search}${location.hash}`);
  return true;
}
