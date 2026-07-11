const approveCommandPrefixes = [
  "orkestr connect approve",
  "orkestr security approve",
  "approve challenge",
  "/approve challenge",
];

function compactCommand(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function approveCommandMatch(value) {
  return compactCommand(value).match(/^(?:sudo\s+)?(?:orkestr\s+(?:connect|security)\s+approve|\/?approve\s+challenge:?)\s+([A-Za-z0-9_-]{4,})$/i);
}

export function exactSecurityApproveChallengeId(value) {
  return approveCommandMatch(value)?.[1] || "";
}

function pairingApprovalPasteContext(value) {
  const text = String(value || "").toLowerCase();
  const hasApprovalCommand =
    text.includes("orkestr connect approve") ||
    text.includes("orkestr security approve") ||
    text.includes("approve challenge");
  if (!hasApprovalCommand) return false;
  return (
    text.includes("pairing required") ||
    text.includes("approve this browser") ||
    text.includes("approve this shared review") ||
    text.includes("approve from ssh") ||
    text.includes("approve from this server") ||
    (text.includes("challenge id") && text.includes("orkestr security approve"))
  );
}

export function rawSecurityApproveChallengeId(value) {
  const exact = exactSecurityApproveChallengeId(value);
  if (exact) return exact;
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
