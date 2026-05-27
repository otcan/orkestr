const approveCommandPrefixes = [
  "orkestr security approve",
  "approve challenge",
  "/approve challenge",
];

function compactCommand(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function rawSecurityApproveChallengeId(value) {
  const text = compactCommand(value);
  const match = text.match(/^(?:orkestr\s+security\s+approve|\/?approve\s+challenge:?)\s+([A-Za-z0-9_-]{20,})$/i);
  return match?.[1] || "";
}

export function rawControlCommandMayMatch(value) {
  const text = compactCommand(value).toLowerCase();
  if (!text) return false;
  return approveCommandPrefixes.some((prefix) => prefix.startsWith(text) || text.startsWith(prefix));
}
