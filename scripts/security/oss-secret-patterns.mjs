// High-signal secret patterns for the public OSS tree (run by
// `npm run oss:boundary-check`). Gitleaks in CI covers history; this is the
// fast local gate that also covers test fixtures.

// Values that read as fixtures rather than live credentials.
const fakeMarker = /test|fake|example|dummy|placeholder|redacted|fixture|sample|secret|token|explicit|alice|bob|user|xxxx|invalid/i;

// Phone-like digits that are obviously synthetic: 555 ranges, zero padding,
// counting sequences, long repeats, or very few distinct digits.
export function isFakeDigits(digits) {
  return /555|0{4}|1234|2345|3456|9876|(\d)\1{4}/.test(digits) || new Set(digits).size <= 3;
}

export const secretPatterns = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: "OpenAI key", pattern: /\bsk-(?:proj-|svcacct-|admin-|live-)?[A-Za-z0-9_-]{20,}\b/, fake: (value) => fakeMarker.test(value) },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, fake: (value) => /EXAMPLE|0{8}/.test(value) },
  { name: "Google OAuth secret", pattern: /\bGOCSPX-[A-Za-z0-9_-]{10,}\b/, fake: (value) => fakeMarker.test(value) },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/, fake: (value) => fakeMarker.test(value) },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{32,}=*/, fake: (value) => fakeMarker.test(value) },
  { name: "numeric WhatsApp id", pattern: /\b(\d{10,})@(?:c\.us|g\.us|s\.whatsapp\.net|lid)\b/i, fake: (_value, digits) => isFakeDigits(digits) },
];

// Lines carrying this marker are reviewed fake values that the heuristics miss.
export const allowMarker = "oss-secret-scan: allow-fake";

export function scanText(text) {
  const findings = [];
  text.split("\n").forEach((line, index) => {
    if (line.includes(allowMarker)) return;
    for (const { name, pattern, fake } of secretPatterns) {
      const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      for (const match of line.matchAll(global)) {
        if (!fake?.(match[0], match[1])) {
          findings.push({ line: index + 1, name });
          break;
        }
      }
    }
  });
  return findings;
}
