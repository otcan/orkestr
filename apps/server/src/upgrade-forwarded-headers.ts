import type { IncomingMessage } from "node:http";

const forwardedNames = new Set(["x-forwarded-host", "x-forwarded-proto"]);

export function appendSanitizedForwardedHeaders(lines: string[], request: IncomingMessage): void {
  const host = String(request.headers["x-forwarded-host"] || "").trim();
  const proto = String(request.headers["x-forwarded-proto"] || "").trim();
  if (host) lines.push(`X-Forwarded-Host: ${host}`);
  if (proto) lines.push(`X-Forwarded-Proto: ${proto}`);
}

export function rawUpgradeHeaderAllowed(name = ""): boolean {
  return !forwardedNames.has(String(name || "").toLowerCase());
}
