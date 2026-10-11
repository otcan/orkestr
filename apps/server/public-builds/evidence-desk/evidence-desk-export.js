// Evidence desk: reproducible exports. Output depends only on the state, never
// on the clock, locale or browser, so the same data always produces
// byte-identical JSON and Markdown (and therefore the same checksum).
import { EVIDENCE_TYPES, OUTCOMES, STANCES, STATE_VERSION, STRENGTHS, claimHistory, sourceLabel } from "./evidence-desk-state.js";
import { RUBRIC_NOTE, reviewQueue, reviewReasons, scoreClaim } from "./evidence-desk-score.js";
import { SAMPLE_DESCRIPTION } from "./evidence-desk-sample.js";

// FNV-1a 32-bit over UTF-8 bytes. A reproducibility fingerprint, not a security hash.
export function checksum(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-${hash.toString(16).padStart(8, "0")}`;
}

function exportPayload(state) {
  return {
    kind: "orkestr-evidence-desk-demo",
    version: STATE_VERSION,
    synthetic: true,
    dataNotice: `${SAMPLE_DESCRIPTION} Items added in the browser are also treated as synthetic.`,
    rubric: {
      note: RUBRIC_NOTE,
      formula: "50 + 50 * (support - against) / (support + against + 2)",
      strengthWeights: STRENGTHS,
      typeWeights: Object.fromEntries(Object.entries(EVIDENCE_TYPES).map(([key, entry]) => [key, entry.weight])),
    },
    sources: state.sources.map((source) => ({ ...source, citedBy: state.evidence.filter((item) => item.sourceId === source.id).map((item) => item.id) })),
    claims: state.claims.map((claim) => {
      const result = scoreClaim(state, claim.id);
      return {
        id: claim.id,
        text: claim.text,
        rubricScore: result.score,
        rubricLabel: result.label,
        supportWeight: result.support,
        againstWeight: result.against,
        distinctSources: result.sources,
        reviewed: claim.reviewed,
        decision: claim.decision,
        reviewReasons: reviewReasons(state, claim.id).map((reason) => reason.code),
        contradicts: claim.contradicts,
        evidence: state.evidence.filter((item) => item.claimId === claim.id).map(({ claimId, ...item }) => item),
        history: claimHistory(state, claim.id).map(({ claimId, ...entry }) => entry),
      };
    }),
  };
}

// The checksum embedded in the JSON export; shown in the UI and used in file names.
export function exportChecksum(state) {
  return checksum(JSON.stringify(exportPayload(state), null, 2));
}

export function exportJson(state) {
  const body = JSON.stringify(exportPayload(state), null, 2);
  return `${body.slice(0, -2)},\n  "checksum": "${checksum(body)}"\n}\n`;
}

function mdEscape(value) {
  return String(value).replace(/([\\`*_[\]#|<>])/g, "\\$1");
}

export function exportMarkdown(state) {
  const lines = ["# Evidence desk summary — fictional demo data", ""];
  lines.push(`> ${SAMPLE_DESCRIPTION} Items added in the browser are also treated as synthetic.`, ">", `> ${RUBRIC_NOTE}`, "");
  lines.push("| Claim | Rubric score | Status | Evidence | Decision |", "| --- | ---: | --- | ---: | --- |");
  for (const claim of state.claims) {
    const result = scoreClaim(state, claim.id);
    lines.push(`| ${claim.id.toUpperCase()} ${mdEscape(claim.text)} | ${result.score} | ${result.label} | ${result.count} | ${claim.decision ? OUTCOMES[claim.decision.outcome] : "—"} |`);
  }
  const queue = reviewQueue(state);
  lines.push("", "## Review queue", "");
  if (!queue.length) lines.push("Nothing waiting for review.");
  for (const entry of queue) lines.push(`- ${entry.claimId.toUpperCase()} ${mdEscape(entry.text)} — ${entry.reasons.map((reason) => reason.text).join("; ")}`);
  for (const claim of state.claims) {
    lines.push("", `## ${claim.id.toUpperCase()} ${mdEscape(claim.text)}`, "", "Evidence:", "");
    const items = state.evidence.filter((item) => item.claimId === claim.id);
    if (!items.length) lines.push("- No evidence attached.");
    for (const item of items) {
      const source = state.sources.find((entry) => entry.id === item.sourceId);
      lines.push(`- ${item.id.toUpperCase()} ${STANCES[item.stance]}: [${mdEscape(sourceLabel(source))}](#${source.id}) (${EVIDENCE_TYPES[item.type].label}, ${item.strength})${item.note ? ` — ${mdEscape(item.note)}` : ""}`);
    }
    if (claim.contradicts.length) lines.push("", `Contradicts: ${claim.contradicts.map((id) => id.toUpperCase()).join(", ")}`);
    lines.push("", "Decision history:", "");
    const history = claimHistory(state, claim.id);
    if (!history.length) lines.push("- No recorded steps.");
    for (const entry of history) lines.push(`- Step ${entry.n}: ${mdEscape(entry.text)}`);
  }
  lines.push("", "## Source records", "");
  for (const source of state.sources) {
    const cited = state.evidence.filter((item) => item.sourceId === source.id).map((item) => item.id.toUpperCase());
    lines.push(`<a id="${source.id}"></a>`, `### ${mdEscape(sourceLabel(source))}`, "", `- Kind: ${mdEscape(source.kind)}`);
    if (source.excerpt) lines.push(`- Excerpt: ${mdEscape(source.excerpt)}`);
    lines.push(`- Provenance: ${mdEscape(source.provenance)}`, `- Cited by: ${cited.length ? cited.join(", ") : "not cited"}`, "");
  }
  const body = `${lines.join("\n").trimEnd()}\n`;
  return `${body}\n---\nChecksum: ${checksum(body)}\n`;
}

export function exportFileName(state, extension) {
  return `evidence-desk-${exportChecksum(state).slice(8)}.${extension}`;
}
