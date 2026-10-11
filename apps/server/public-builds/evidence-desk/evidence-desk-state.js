// Evidence desk: pure state transitions. No DOM, no network, no clock.
// Loaded by the browser as an ES module and imported directly by unit tests.
// Every mutation is deterministic: the same sequence of actions always yields
// the same ids, history numbers and therefore byte-identical exports.

export const STORAGE_KEY = "orkestr.builds.evidence-desk.v2";
export const STATE_VERSION = 2;
export const MAX_CLAIMS = 60;
export const MAX_EVIDENCE = 400;
export const MAX_SOURCES = 200;
export const MAX_HISTORY = 1000;
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
export const OUTCOMES = { accepted: "Accepted", rejected: "Rejected", "needs-evidence": "Needs more evidence" };
export const USER_SOURCE_PROVENANCE = "Entered in this browser for the demo. Treat as synthetic.";

export function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function pick(value, allowed, fallback) {
  return Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback;
}

function nextId(state, prefix) {
  return { id: `${prefix}${state.seq}`, state: { ...state, seq: state.seq + 1 } };
}

export function emptyState() {
  return { version: STATE_VERSION, seq: 1, sseq: 1, hseq: 1, sources: [], claims: [], evidence: [], history: [] };
}

export function sourceLabel(source) {
  return `${source.id.toUpperCase()} · ${source.title}`;
}

function log(state, claimId, action, text) {
  const history = [...state.history, { n: state.hseq, claimId, action, text }];
  return { ...state, hseq: state.hseq + 1, history: history.slice(-MAX_HISTORY) };
}

export function requireClaim(state, claimId) {
  const claim = state.claims.find((item) => item.id === claimId);
  if (!claim) throw new Error("Claim not found.");
  return claim;
}

// Any change to a claim's evidence, text or links invalidates an earlier review.
function invalidate(state, claimIds, why) {
  let next = state;
  for (const id of claimIds) {
    const claim = next.claims.find((item) => item.id === id);
    if (!claim?.decision) continue;
    next = { ...next, claims: next.claims.map((item) => (item.id === id ? { ...item, reviewed: false, decision: null } : item)) };
    next = log(next, id, "reopened", `Earlier review decision cleared: ${why}.`);
  }
  return next;
}

export function addSource(state, fields) {
  const title = cleanText(fields.title);
  if (!title) throw new Error("Source title is required.");
  if (state.sources.length >= MAX_SOURCES) throw new Error(`The demo is limited to ${MAX_SOURCES} source records.`);
  const id = `s${state.sseq}`;
  const source = { id, title, kind: cleanText(fields.kind) || "Synthetic record", excerpt: cleanText(fields.excerpt, MAX_NOTE), provenance: cleanText(fields.provenance, MAX_NOTE) || USER_SOURCE_PROVENANCE };
  return { id, state: { ...state, sseq: state.sseq + 1, sources: [...state.sources, source] } };
}

// Resolves a source title typed by the user to an existing record (case
// insensitive) or creates a new one, so every evidence item stays traceable.
export function ensureSource(state, title) {
  const value = cleanText(title);
  if (!value) throw new Error("Evidence source is required.");
  const existing = state.sources.find((source) => source.title.toLowerCase() === value.toLowerCase() || source.id === value.toLowerCase());
  return existing ? { id: existing.id, state } : addSource(state, { title: value });
}

export function addClaim(state, text) {
  const value = cleanText(text);
  if (!value) throw new Error("Claim text is required.");
  if (state.claims.length >= MAX_CLAIMS) throw new Error(`The demo is limited to ${MAX_CLAIMS} claims.`);
  const next = nextId(state, "c");
  const claim = { id: next.id, text: value, reviewed: false, decision: null, contradicts: [] };
  return { id: next.id, state: log({ ...next.state, claims: [...next.state.claims, claim] }, next.id, "created", "Claim created.") };
}

export function updateClaim(state, claimId, text) {
  const value = cleanText(text);
  if (!value) throw new Error("Claim text is required.");
  const claim = requireClaim(state, claimId);
  if (claim.text === value) return state;
  const next = { ...state, claims: state.claims.map((item) => (item.id === claimId ? { ...item, text: value } : item)) };
  return invalidate(log(next, claimId, "edited", `Text changed from “${claim.text}”.`), [claimId], "claim text changed");
}

export function deleteClaim(state, claimId) {
  requireClaim(state, claimId);
  const peers = state.claims.filter((claim) => claim.contradicts.includes(claimId)).map((claim) => claim.id);
  let next = {
    ...state,
    claims: state.claims.filter((claim) => claim.id !== claimId).map((claim) => ({ ...claim, contradicts: claim.contradicts.filter((id) => id !== claimId) })),
    evidence: state.evidence.filter((item) => item.claimId !== claimId),
    history: state.history.filter((entry) => entry.claimId !== claimId),
  };
  for (const peer of peers) next = log(next, peer, "unlinked", `Contradiction link removed because claim ${claimId.toUpperCase()} was deleted.`);
  return invalidate(next, peers, "a linked claim was deleted");
}

export function recordDecision(state, claimId, outcome, rationale = "") {
  requireClaim(state, claimId);
  const value = pick(outcome, OUTCOMES, "");
  if (!value) throw new Error("Choose a review outcome.");
  const note = cleanText(rationale, MAX_NOTE);
  const decision = { outcome: value, rationale: note, n: state.hseq };
  const next = { ...state, claims: state.claims.map((claim) => (claim.id === claimId ? { ...claim, reviewed: value !== "needs-evidence", decision } : claim)) };
  return log(next, claimId, "decision", `Review decision: ${OUTCOMES[value]}.${note ? ` Rationale: ${note}` : ""}`);
}

export function reopenClaim(state, claimId) {
  const claim = requireClaim(state, claimId);
  if (!claim.decision) return state;
  const next = { ...state, claims: state.claims.map((item) => (item.id === claimId ? { ...item, reviewed: false, decision: null } : item)) };
  return log(next, claimId, "reopened", "Review reopened by the reviewer.");
}

function evidenceFields(fields) {
  return {
    type: pick(fields.type, EVIDENCE_TYPES, "observation"),
    strength: pick(fields.strength, STRENGTHS, "moderate"),
    stance: pick(fields.stance, STANCES, "supports"),
    note: cleanText(fields.note, MAX_NOTE),
  };
}

function describe(state, item) {
  const source = state.sources.find((entry) => entry.id === item.sourceId);
  return `${item.id.toUpperCase()} (${item.stance}, ${EVIDENCE_TYPES[item.type].label.toLowerCase()}, ${item.strength}) from ${source ? sourceLabel(source) : item.sourceId}`;
}

// fields.source is a title or source id; fields.sourceId wins when present.
export function addEvidence(state, claimId, fields) {
  requireClaim(state, claimId);
  if (state.evidence.length >= MAX_EVIDENCE) throw new Error(`The demo is limited to ${MAX_EVIDENCE} evidence items.`);
  const resolved = fields.sourceId && state.sources.some((source) => source.id === fields.sourceId) ? { id: fields.sourceId, state } : ensureSource(state, fields.source);
  const next = nextId(resolved.state, "e");
  const item = { id: next.id, claimId, sourceId: resolved.id, ...evidenceFields(fields) };
  const added = log({ ...next.state, evidence: [...next.state.evidence, item] }, claimId, "evidence-added", `Evidence ${describe(next.state, item)} attached.`);
  return { id: next.id, state: invalidate(added, [claimId], "evidence was added") };
}

export function updateEvidence(state, evidenceId, fields) {
  const existing = state.evidence.find((item) => item.id === evidenceId);
  if (!existing) throw new Error("Evidence not found.");
  const resolved = fields.source != null ? ensureSource(state, fields.source) : { id: existing.sourceId, state };
  const item = { ...existing, sourceId: resolved.id, ...evidenceFields({ ...existing, ...fields }) };
  if (JSON.stringify(item) === JSON.stringify(existing)) return resolved.state;
  const next = { ...resolved.state, evidence: resolved.state.evidence.map((entry) => (entry.id === evidenceId ? item : entry)) };
  return invalidate(log(next, existing.claimId, "evidence-edited", `Evidence changed to ${describe(next, item)}.`), [existing.claimId], "evidence was edited");
}

export function removeEvidence(state, evidenceId) {
  const existing = state.evidence.find((item) => item.id === evidenceId);
  if (!existing) throw new Error("Evidence not found.");
  const next = log({ ...state, evidence: state.evidence.filter((item) => item.id !== evidenceId) }, existing.claimId, "evidence-removed", `Evidence ${describe(state, existing)} removed.`);
  return invalidate(next, [existing.claimId], "evidence was removed");
}

export function linkContradiction(state, claimA, claimB) {
  if (claimA === claimB) throw new Error("A claim cannot contradict itself.");
  const a = requireClaim(state, claimA);
  requireClaim(state, claimB);
  if (a.contradicts.includes(claimB)) return state;
  let next = {
    ...state,
    claims: state.claims.map((claim) => (claim.id === claimA ? { ...claim, contradicts: [...claim.contradicts, claimB] } : claim.id === claimB ? { ...claim, contradicts: [...claim.contradicts, claimA] } : claim)),
  };
  next = log(next, claimA, "linked", `Marked as contradicting ${claimB.toUpperCase()}.`);
  next = log(next, claimB, "linked", `Marked as contradicting ${claimA.toUpperCase()}.`);
  return invalidate(next, [claimA, claimB], "a contradiction link was added");
}

export function unlinkContradiction(state, claimA, claimB) {
  const a = state.claims.find((claim) => claim.id === claimA);
  if (!a || !a.contradicts.includes(claimB)) return state;
  let next = {
    ...state,
    claims: state.claims.map((claim) => (claim.id === claimA ? { ...claim, contradicts: claim.contradicts.filter((id) => id !== claimB) } : claim.id === claimB ? { ...claim, contradicts: claim.contradicts.filter((id) => id !== claimA) } : claim)),
  };
  next = log(next, claimA, "unlinked", `Contradiction link with ${claimB.toUpperCase()} removed.`);
  next = log(next, claimB, "unlinked", `Contradiction link with ${claimA.toUpperCase()} removed.`);
  return invalidate(next, [claimA, claimB], "a contradiction link was removed");
}

export function claimHistory(state, claimId) {
  return state.history.filter((entry) => entry.claimId === claimId);
}

export function citations(state, sourceId) {
  return state.evidence.filter((item) => item.sourceId === sourceId);
}

// Accepts anything (e.g. corrupted localStorage) and returns a valid state or null.
export function sanitizeState(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== STATE_VERSION || ![raw.claims, raw.evidence, raw.sources, raw.history].every(Array.isArray)) return null;
  const sources = [];
  const sourceIds = new Set();
  for (const entry of raw.sources.slice(0, MAX_SOURCES)) {
    const id = String(entry?.id || "");
    const title = cleanText(entry?.title);
    if (!/^s\d+$/.test(id) || !title || sourceIds.has(id)) continue;
    sourceIds.add(id);
    sources.push({ id, title, kind: cleanText(entry.kind) || "Synthetic record", excerpt: cleanText(entry.excerpt, MAX_NOTE), provenance: cleanText(entry.provenance, MAX_NOTE) || USER_SOURCE_PROVENANCE });
  }
  const claims = [];
  const ids = new Set();
  for (const entry of raw.claims.slice(0, MAX_CLAIMS)) {
    const id = String(entry?.id || "");
    const text = cleanText(entry?.text);
    if (!/^c\d+$/.test(id) || !text || ids.has(id)) continue;
    ids.add(id);
    const outcome = pick(entry.decision?.outcome, OUTCOMES, "");
    const decision = outcome ? { outcome, rationale: cleanText(entry.decision.rationale, MAX_NOTE), n: Number.isInteger(entry.decision.n) ? entry.decision.n : 0 } : null;
    claims.push({ id, text, reviewed: Boolean(decision) && outcome !== "needs-evidence", decision, contradicts: Array.isArray(entry.contradicts) ? entry.contradicts.map(String) : [] });
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
    if (!/^e\d+$/.test(id) || evidenceIds.has(id) || !ids.has(String(entry.claimId)) || !sourceIds.has(String(entry.sourceId))) continue;
    evidence.push({ id, claimId: String(entry.claimId), sourceId: String(entry.sourceId), ...evidenceFields(entry) });
    evidenceIds.add(id);
  }
  const history = raw.history.slice(-MAX_HISTORY)
    .filter((entry) => Number.isInteger(entry?.n) && ids.has(String(entry.claimId)))
    .map((entry) => ({ n: entry.n, claimId: String(entry.claimId), action: cleanText(entry.action, 40), text: cleanText(entry.text, MAX_NOTE) }));
  const maxSeq = [...ids, ...evidenceIds].reduce((max, id) => Math.max(max, Number(id.slice(1))), 0);
  const maxSource = [...sourceIds].reduce((max, id) => Math.max(max, Number(id.slice(1))), 0);
  const maxH = history.reduce((max, entry) => Math.max(max, entry.n), 0);
  return {
    version: STATE_VERSION,
    seq: Math.max(Number.isInteger(raw.seq) ? raw.seq : 1, maxSeq + 1),
    sseq: Math.max(Number.isInteger(raw.sseq) ? raw.sseq : 1, maxSource + 1),
    hseq: Math.max(Number.isInteger(raw.hseq) ? raw.hseq : 1, maxH + 1),
    sources, claims, evidence, history,
  };
}
