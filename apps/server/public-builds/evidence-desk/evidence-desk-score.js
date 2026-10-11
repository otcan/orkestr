// Evidence desk: illustrative rubric score and review queue. This is a simple,
// fully explained heuristic for the demo. It is NOT a calibrated, statistical
// or scientific confidence measure and says nothing about whether a source is true.
import { EVIDENCE_TYPES, STRENGTHS, requireClaim } from "./evidence-desk-state.js";

export const RUBRIC_NOTE = "Illustrative rubric for this demo only. Not a calibrated or scientific confidence measure.";

export function evidenceWeight(item) {
  return STRENGTHS[item.strength] * EVIDENCE_TYPES[item.type].weight;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

// Rubric score 0-100. 50 means balanced or no evidence. The +2 prior keeps a
// single item from pushing a claim to an extreme.
export function scoreClaim(state, claimId) {
  const items = state.evidence.filter((item) => item.claimId === claimId);
  let support = 0;
  let against = 0;
  for (const item of items) {
    if (item.stance === "contradicts") against += evidenceWeight(item);
    else support += evidenceWeight(item);
  }
  const score = Math.max(0, Math.min(100, Math.round(50 + (50 * (support - against)) / (support + against + 2))));
  const sources = new Set(items.map((item) => item.sourceId)).size;
  let label = "Inconclusive";
  if (!items.length) label = "No evidence";
  else if (sources < 2) label = "Thin evidence";
  else if (support > 0 && against > 0 && score > 30 && score < 70) label = "Contested";
  else if (score >= 70) label = "Well supported";
  else if (score >= 55) label = "Leaning supported";
  else if (score <= 30) label = "Leaning refuted";
  return { score, support: round1(support), against: round1(against), count: items.length, sources, label };
}

export function reviewReasons(state, claimId) {
  const claim = requireClaim(state, claimId);
  const items = state.evidence.filter((item) => item.claimId === claimId);
  const result = scoreClaim(state, claimId);
  const reasons = [];
  if (claim.decision?.outcome === "needs-evidence") reasons.push({ code: "reviewer-requested-evidence", priority: 2, text: "Reviewer asked for more evidence" });
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
