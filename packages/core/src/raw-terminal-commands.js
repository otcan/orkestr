const approveCommandPrefixes = [
  "orkestr security approve",
  "approve challenge",
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

export function rawControlCommandMayMatch(value) {
  const text = compactCommand(value).toLowerCase();
  if (!text) return false;
  return approveCommandPrefixes.some((prefix) => prefix.startsWith(text) || text.startsWith(prefix));
}
