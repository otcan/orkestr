// Evidence desk: pure state, scoring and export logic. No DOM, no network.
// Loaded by the browser as an ES module and imported directly by unit tests.

export const STORAGE_KEY = "orkestr.builds.evidence-desk.v1";
export const STATE_VERSION = 1;
export const MAX_CLAIMS = 60;
export const MAX_EVIDENCE = 400;
export const MAX_TEXT = 280;
export const MAX_NOTE = 500;

export const EVIDENCE_TYPES = {
  "primary-record": { label: "Primary record", weight: 1 },
  measurement: { label: "Measurement", weight: 1 },
  observation: { label: "Observation", weight: 0.8 },
  "secondary-report": { label: "Secondary report", weight: 0.6 },
  anecdote: { label: "Anecdote", weight: 0.4 },
};
export const STRENGTHS = { weak: 1, moderate: 2, strong: 3 };
export const STANCES = { supports: "Supports", contradicts: "Contradicts" };

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function pick(value, allowed, fallback) {
  return Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback;
}

function nextId(state, prefix) {
  return { id: `${prefix}${state.seq}`, state: { ...state, seq: state.seq + 1 } };
}

export function emptyState() {
  return { version: STATE_VERSION, seq: 1, claims: [], evidence: [] };
}

// Fictional dataset: an invented town's tool-lending library. No real people,
// places, organisations or health topics.
export function sampleState() {
  let state = emptyState();
  const claim = (text) => {
    const result = addClaim(state, text);
    state = result.state;
    return result.id;
  };
  const evidence = (claimId, fields) => {
    state = addEvidence(state, claimId, fields).state;
  };
  const c1 = claim("The Brindlemere tool library lent more items in spring than in winter.");
  const c2 = claim("Opening on Saturdays brought in more first-time borrowers.");
  const c3 = claim("Most borrowed tools come back on time.");
  const c4 = claim("Late returns mostly involve garden equipment.");
  const c5 = claim("Saturday opening made no difference to borrowing.");
  evidence(c1, { source: "Synthetic loan ledger, Jan–May", type: "primary-record", strength: "strong", stance: "supports", note: "Spring loans are roughly double winter loans in the invented ledger." });
  evidence(c1, { source: "Volunteer shift notes (fictional)", type: "observation", strength: "moderate", stance: "supports" });
  evidence(c2, { source: "Synthetic sign-up sheet counts", type: "measurement", strength: "moderate", stance: "supports" });
  evidence(c2, { source: "Fictional community newsletter", type: "secondary-report", strength: "weak", stance: "supports" });
  evidence(c2, { source: "Synthetic door-counter log", type: "measurement", strength: "moderate", stance: "contradicts", note: "Visitor totals stay flat after Saturday opening." });
  evidence(c3, { source: "Synthetic return log", type: "primary-record", strength: "strong", stance: "supports" });
  evidence(c3, { source: "Invented reminder-email report", type: "secondary-report", strength: "moderate", stance: "supports" });
  evidence(c5, { source: "Fictional board meeting remark", type: "anecdote", strength: "weak", stance: "supports" });
  state = linkContradiction(state, c2, c5);
  return state;
}

export function addClaim(state, text) {
  const value = cleanText(text);
  if (!value) throw new Error("Claim text is required.");
  if (state.claims.length >= MAX_CLAIMS) throw new Error(`The demo is limited to ${MAX_CLAIMS} claims.`);
  const next = nextId(state, "c");
  const claim = { id: next.id, text: value, reviewed: false, contradicts: [] };
  return { id: next.id, state: { ...next.state, claims: [...next.state.claims, claim] } };
}

function touchClaims(claims, ids) {
  return claims.map((claim) => (ids.includes(claim.id) ? { ...claim, reviewed: false } : claim));
}

export function updateClaim(state, claimId, text) {
  const value = cleanText(text);
  if (!value) throw new Error("Claim text is required.");
  requireClaim(state, claimId);
  return { ...state, claims: state.claims.map((claim) => (claim.id === claimId ? { ...claim, text: value, reviewed: false } : claim)) };
}

export function deleteClaim(state, claimId) {
  requireClaim(state, claimId);
  const claims = state.claims
    .filter((claim) => claim.id !== claimId)
    .map((claim) => (claim.contradicts.includes(claimId) ? { ...claim, contradicts: claim.contradicts.filter((id) => id !== claimId), reviewed: false } : claim));
  return { ...state, claims, evidence: state.evidence.filter((item) => item.claimId !== claimId) };
}

export function setReviewed(state, claimId, reviewed = true) {
  requireClaim(state, claimId);
  return { ...state, claims: state.claims.map((claim) => (claim.id === claimId ? { ...claim, reviewed: Boolean(reviewed) } : claim)) };
}

function requireClaim(state, claimId) {
  const claim = state.claims.find((item) => item.id === claimId);
  if (!claim) throw new Error("Claim not found.");
  return claim;
}

function evidenceFields(fields) {
  const source = cleanText(fields.source);
  if (!source) throw new Error("Evidence source is required.");
  return {
    source,
    type: pick(fields.type, EVIDENCE_TYPES, "observation"),
    strength: pick(fields.strength, STRENGTHS, "moderate"),
    stance: pick(fields.stance, STANCES, "supports"),
    note: cleanText(fields.note, MAX_NOTE),
  };
}

export function addEvidence(state, claimId, fields) {
  requireClaim(state, claimId);
  if (state.evidence.length >= MAX_EVIDENCE) throw new Error(`The demo is limited to ${MAX_EVIDENCE} evidence items.`);
  const item = evidenceFields(fields);
  const next = nextId(state, "e");
  return {
    id: next.id,
    state: { ...next.state, evidence: [...next.state.evidence, { id: next.id, claimId, ...item }], claims: touchClaims(next.state.claims, [claimId]) },
  };
}

export function updateEvidence(state, evidenceId, fields) {
  const existing = state.evidence.find((item) => item.id === evidenceId);
  if (!existing) throw new Error("Evidence not found.");
  const item = evidenceFields({ ...existing, ...fields });
  return {
    ...state,
    evidence: state.evidence.map((entry) => (entry.id === evidenceId ? { ...entry, ...item } : entry)),
    claims: touchClaims(state.claims, [existing.claimId]),
  };
}

export function removeEvidence(state, evidenceId) {
  const existing = state.evidence.find((item) => item.id === evidenceId);
  if (!existing) throw new Error("Evidence not found.");
  return { ...state, evidence: state.evidence.filter((item) => item.id !== evidenceId), claims: touchClaims(state.claims, [existing.claimId]) };
}

export function linkContradiction(state, claimA, claimB) {
  if (claimA === claimB) throw new Error("A claim cannot contradict itself.");
  requireClaim(state, claimA);
  requireClaim(state, claimB);
  const claims = state.claims.map((claim) => {
    const other = claim.id === claimA ? claimB : claim.id === claimB ? claimA : "";
    if (!other || claim.contradicts.includes(other)) return claim;
    return { ...claim, contradicts: [...claim.contradicts, other], reviewed: false };
  });
  return { ...state, claims };
}

export function unlinkContradiction(state, claimA, claimB) {
  const claims = state.claims.map((claim) => {
    const other = claim.id === claimA ? claimB : claim.id === claimB ? claimA : "";
    if (!other || !claim.contradicts.includes(other)) return claim;
    return { ...claim, contradicts: claim.contradicts.filter((id) => id !== other), reviewed: false };
  });
  return { ...state, claims };
}

export function evidenceWeight(item) {
  return STRENGTHS[item.strength] * EVIDENCE_TYPES[item.type].weight;
}

// Score 0-100. 50 means balanced or no evidence. The +2 prior keeps a single
// item from pushing a claim to an extreme.
export function scoreClaim(state, claimId) {
  const items = state.evidence.filter((item) => item.claimId === claimId);
  let support = 0;
  let against = 0;
  for (const item of items) {
    if (item.stance === "contradicts") against += evidenceWeight(item);
    else support += evidenceWeight(item);
  }
  const score = Math.round(50 + (50 * (support - against)) / (support + against + 2));
  const sources = new Set(items.map((item) => item.source.toLowerCase())).size;
  let label = "Inconclusive";
  if (!items.length) label = "No evidence";
  else if (sources < 2) label = "Thin evidence";
  else if (support > 0 && against > 0 && score > 30 && score < 70) label = "Contested";
  else if (score >= 70) label = "Well supported";
  else if (score >= 55) label = "Leaning supported";
  else if (score <= 30) label = "Leaning refuted";
  return { score: Math.max(0, Math.min(100, score)), support: round1(support), against: round1(against), count: items.length, sources, label };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function reviewReasons(state, claimId) {
  const claim = requireClaim(state, claimId);
  const items = state.evidence.filter((item) => item.claimId === claimId);
  const result = scoreClaim(state, claimId);
  const reasons = [];
  if (claim.contradicts.length) reasons.push({ code: "linked-contradiction", priority: 3, text: `Contradicts ${claim.contradicts.length} other claim${claim.contradicts.length === 1 ? "" : "s"}` });
  if (result.against > 0) reasons.push({ code: "contradicting-evidence", priority: 3, text: "Has contradicting evidence" });
  if (!items.length) reasons.push({ code: "no-evidence", priority: 2, text: "No evidence attached" });
  else if (result.sources < 2) reasons.push({ code: "single-source", priority: 1, text: "Relies on a single source" });
  if (items.length && items.every((item) => item.strength === "weak")) reasons.push({ code: "weak-only", priority: 1, text: "Only weak evidence" });
  return reasons;
}

export function reviewQueue(state) {
  return state.claims
    .filter((claim) => !claim.reviewed)
    .map((claim) => {
      const reasons = reviewReasons(state, claim.id);
      return { claimId: claim.id, text: claim.text, reasons, priority: reasons.reduce((sum, reason) => sum + reason.priority, 0) };
    })
    .filter((entry) => entry.reasons.length)
    .sort((a, b) => b.priority - a.priority || a.claimId.localeCompare(b.claimId, "en", { numeric: true }));
}

// Accepts anything (e.g. corrupted localStorage) and returns a valid state or null.
export function sanitizeState(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== STATE_VERSION || !Array.isArray(raw.claims) || !Array.isArray(raw.evidence)) return null;
  const claims = [];
  const ids = new Set();
  for (const entry of raw.claims.slice(0, MAX_CLAIMS)) {
    const id = String(entry?.id || "");
    const text = cleanText(entry?.text);
    if (!/^c\d+$/.test(id) || !text || ids.has(id)) continue;
    ids.add(id);
    claims.push({ id, text, reviewed: entry.reviewed === true, contradicts: Array.isArray(entry.contradicts) ? entry.contradicts.map(String) : [] });
  }
  for (const claim of claims) claim.contradicts = [...new Set(claim.contradicts)].filter((id) => id !== claim.id && ids.has(id));
  for (const claim of claims) for (const other of claim.contradicts) {
    const peer = claims.find((item) => item.id === other);
    if (!peer.contradicts.includes(claim.id)) peer.contradicts.push(claim.id);
  }
  const evidence = [];
  const evidenceIds = new Set();
  for (const entry of raw.evidence.slice(0, MAX_EVIDENCE)) {
    const id = String(entry?.id || "");
    if (!/^e\d+$/.test(id) || evidenceIds.has(id) || !ids.has(String(entry.claimId))) continue;
    try {
      evidence.push({ id, claimId: String(entry.claimId), ...evidenceFields(entry) });
      evidenceIds.add(id);
    } catch {
      // Skip malformed items rather than discarding the whole dataset.
    }
  }
  const maxSeq = [...ids, ...evidenceIds].reduce((max, id) => Math.max(max, Number(id.slice(1))), 0);
  const seq = Math.max(Number.isInteger(raw.seq) ? raw.seq : 1, maxSeq + 1);
  return { version: STATE_VERSION, seq, claims, evidence };
}

export function exportJson(state, exportedAt = "") {
  const claims = state.claims.map((claim) => ({
    id: claim.id,
    text: claim.text,
    reviewed: claim.reviewed,
    contradicts: claim.contradicts,
    ...scoreClaim(state, claim.id),
    reviewReasons: reviewReasons(state, claim.id).map((reason) => reason.code),
    evidence: state.evidence.filter((item) => item.claimId === claim.id).map(({ claimId, ...item }) => item),
  }));
  const payload = { kind: "orkestr-evidence-desk-demo", synthetic: true, version: STATE_VERSION, ...(exportedAt ? { exportedAt } : {}), claims };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function mdEscape(value) {
  return String(value).replace(/([\\`*_[\]#|<>])/g, "\\$1");
}

export function exportMarkdown(state, exportedAt = "") {
  const lines = ["# Evidence desk summary (synthetic demo data)", ""];
  if (exportedAt) lines.push(`Exported: ${exportedAt}`, "");
  lines.push("Generated in the browser from fictional sample data. Not research findings.", "");
  lines.push("| Claim | Score | Status | Evidence | Reviewed |", "| --- | ---: | --- | ---: | --- |");
  for (const claim of state.claims) {
    const result = scoreClaim(state, claim.id);
    lines.push(`| ${mdEscape(claim.text)} | ${result.score} | ${result.label} | ${result.count} | ${claim.reviewed ? "yes" : "no"} |`);
  }
  const queue = reviewQueue(state);
  lines.push("", "## Review queue", "");
  if (!queue.length) lines.push("Nothing waiting for review.");
  for (const entry of queue) lines.push(`- ${mdEscape(entry.text)} — ${entry.reasons.map((reason) => reason.text).join("; ")}`);
  for (const claim of state.claims) {
    lines.push("", `## ${mdEscape(claim.text)}`, "");
    const items = state.evidence.filter((item) => item.claimId === claim.id);
    if (!items.length) lines.push("- No evidence attached.");
    for (const item of items) {
      lines.push(`- ${STANCES[item.stance]}: ${mdEscape(item.source)} (${EVIDENCE_TYPES[item.type].label}, ${item.strength})${item.note ? ` — ${mdEscape(item.note)}` : ""}`);
    }
    const links = claim.contradicts.map((id) => state.claims.find((other) => other.id === id)?.text).filter(Boolean);
    if (links.length) lines.push(`- Contradicts: ${links.map(mdEscape).join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}
