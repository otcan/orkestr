const approveCommandPrefixes = [
  "orkestr security approve",
  "orkestr desktop approve",
  "approve challenge",
  "approve desktop",
  "/desktop",
  "/approve challenge",
];

function compactCommand(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function approveCommandMatch(value) {
  return compactCommand(value).match(/^(?:sudo\s+)?(?:orkestr\s+security\s+approve|\/?approve\s+challenge:?)\s+([A-Za-z0-9_-]{20,})$/i);
}

function pairingApprovalPasteContext(value) {
  const text = String(value || "").toLowerCase();
  return (
    text.includes("pairing required") ||
    text.includes("approve from ssh") ||
    (text.includes("challenge id") && text.includes("orkestr security approve"))
  );
}

function desktopApprovalPasteContext(value) {
  const text = String(value || "").toLowerCase();
  return (
    text.includes("orkestr desktop access") ||
    text.includes("desktop challenge") ||
    text.includes("orkestr desktop approve")
  );
}

function desktopApproveCommandMatch(value) {
  return compactCommand(value).match(/^(?:sudo\s+)?(?:orkestr\s+desktop\s+approve|\/?approve\s+desktop:?)\s+(desk-[A-Za-z0-9_-]{20,})$/i);
}

function desktopShareRequestMatch(value) {
  return compactCommand(value).match(/^(?:(\/desktop|\/browser)(?:\s+([a-z0-9][a-z0-9_.-]*))?|(?:desktop|browser|open\s+desktop|share\s+desktop)\s+([a-z0-9][a-z0-9_.-]*))$/i);
}

export function rawSecurityApproveChallengeId(value) {
  const exact = approveCommandMatch(value);
  if (exact) return exact[1];
  if (!pairingApprovalPasteContext(value)) return "";
  const ids = new Set(
    String(value || "")
      .split(/\r?\n/)
      .map((line) => approveCommandMatch(line)?.[1] || "")
      .filter(Boolean)
  );
  return ids.size === 1 ? [...ids][0] : "";
}

export function rawDesktopShareApproveChallenge(value) {
  const exact = desktopApproveCommandMatch(value);
  if (exact) return exact[1];
  if (!desktopApprovalPasteContext(value)) return "";
  const ids = new Set(
    String(value || "")
      .split(/\r?\n/)
      .map((line) => desktopApproveCommandMatch(line)?.[1] || "")
      .filter(Boolean)
  );
  return ids.size === 1 ? [...ids][0] : "";
}

export function rawDesktopShareRequestSlug(value, defaultSlug = "desktop") {
  const match = desktopShareRequestMatch(value);
  if (!match) return "";
  return String(match[2] || match[3] || defaultSlug || "desktop").toLowerCase();
}

export function rawControlCommandMayMatch(value) {
  const text = compactCommand(value).toLowerCase();
  if (!text) return false;
  return approveCommandPrefixes.some((prefix) => prefix.startsWith(text) || text.startsWith(prefix));
}
