import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CLAIMS, addClaim, addEvidence, deleteClaim, emptyState, exportJson, exportMarkdown, linkContradiction,
  removeEvidence, reviewQueue, sampleState, sanitizeState, scoreClaim, setReviewed, unlinkContradiction,
  updateClaim, updateEvidence,
} from "../apps/server/public-builds/evidence-desk/evidence-desk-state.js";
import { renderPublicSite, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";
import { publicBuildAsset, publicBuilds } from "../dist/server/apps/server/src/public-site-builds.js";

const env = { ORKESTR_PUBLIC_SITE_URL: "https://product.example.test", ORKESTR_PUBLIC_APP_URL: "https://app.example.test" };

function withClaim(text = "A fictional claim.") {
  const { id, state } = addClaim(emptyState(), text);
  return { id, state };
}

test("claims are created, trimmed, edited and deleted with their evidence and links", () => {
  let { id, state } = withClaim("  Spaced   claim text  ");
  assert.equal(state.claims[0].text, "Spaced claim text");
  assert.throws(() => addClaim(state, "   "), /required/);
  const second = addClaim(state, "Second claim.");
  state = addEvidence(second.state, id, { source: "Ledger", type: "measurement", strength: "strong" }).state;
  state = linkContradiction(state, id, second.id);
  state = updateClaim(state, id, "Edited claim.");
  assert.equal(state.claims[0].text, "Edited claim.");
  state = deleteClaim(state, id);
  assert.deepEqual(state.claims.map((claim) => claim.id), [second.id]);
  assert.equal(state.evidence.length, 0);
  assert.deepEqual(state.claims[0].contradicts, []);
});

test("claim count is bounded", () => {
  let state = emptyState();
  for (let i = 0; i < MAX_CLAIMS; i += 1) state = addClaim(state, `Claim ${i}`).state;
  assert.throws(() => addClaim(state, "One more"), /limited/);
});

test("evidence fields are validated and unknown enum values fall back to safe defaults", () => {
  const { id, state } = withClaim();
  assert.throws(() => addEvidence(state, id, { source: "" }), /source is required/);
  assert.throws(() => addEvidence(state, "c999", { source: "x" }), /Claim not found/);
  const added = addEvidence(state, id, { source: "Notes", type: "rumour", strength: "huge", stance: "maybe", note: "<b>n</b>" });
  assert.deepEqual(added.state.evidence[0], { id: added.id, claimId: id, source: "Notes", type: "observation", strength: "moderate", stance: "supports", note: "<b>n</b>" });
});

test("score is 50 without evidence and moves with weighted support and contradiction", () => {
  let { id, state } = withClaim();
  assert.deepEqual(scoreClaim(state, id), { score: 50, support: 0, against: 0, count: 0, sources: 0, label: "No evidence" });
  state = addEvidence(state, id, { source: "Ledger", type: "primary-record", strength: "strong" }).state;
  let result = scoreClaim(state, id);
  assert.equal(result.score, 80); // 50 + 50*3/5
  assert.equal(result.label, "Thin evidence");
  const extra = addEvidence(state, id, { source: "Counter", type: "measurement", strength: "moderate", stance: "contradicts" });
  state = extra.state;
  result = scoreClaim(state, id);
  assert.equal(result.score, 57); // 50 + 50*(3-2)/7
  assert.equal(result.label, "Contested");
  state = updateEvidence(state, extra.id, { stance: "supports" });
  assert.equal(scoreClaim(state, id).score, 86); // 50 + 50*5/7
  assert.equal(scoreClaim(state, id).label, "Well supported");
  state = removeEvidence(state, extra.id);
  assert.equal(scoreClaim(state, id).count, 1);
  const refuted = addEvidence(addEvidence(withClaim().state, "c1", { source: "A", type: "measurement", strength: "strong", stance: "contradicts" }).state, "c1", { source: "B", type: "primary-record", strength: "strong", stance: "contradicts" }).state;
  assert.equal(scoreClaim(refuted, "c1").score, 13);
  assert.equal(scoreClaim(refuted, "c1").label, "Leaning refuted");
});

test("contradiction links are symmetric, reject self links and can be removed", () => {
  let state = addClaim(addClaim(emptyState(), "A").state, "B").state;
  assert.throws(() => linkContradiction(state, "c1", "c1"), /itself/);
  state = linkContradiction(state, "c1", "c2");
  state = linkContradiction(state, "c2", "c1");
  assert.deepEqual(state.claims.map((claim) => claim.contradicts), [["c2"], ["c1"]]);
  state = unlinkContradiction(state, "c1", "c2");
  assert.deepEqual(state.claims.map((claim) => claim.contradicts), [[], []]);
});

test("review queue prioritises contradictions and reviewed claims return after changes", () => {
  let state = sampleState();
  const queue = reviewQueue(state);
  assert.equal(queue[0].claimId, "c2");
  assert.ok(queue[0].reasons.some((reason) => reason.code === "contradicting-evidence"));
  assert.ok(queue.some((entry) => entry.reasons.some((reason) => reason.code === "no-evidence")));
  assert.ok(!queue.some((entry) => entry.claimId === "c3"), "well-supported multi-source claim is not queued");
  state = setReviewed(state, "c2");
  assert.ok(!reviewQueue(state).some((entry) => entry.claimId === "c2"));
  state = addEvidence(state, "c2", { source: "Another synthetic log" }).state;
  assert.ok(reviewQueue(state).some((entry) => entry.claimId === "c2"));
});

test("sample dataset is fictional, deterministic and resettable", () => {
  const a = sampleState();
  assert.deepEqual(a, sampleState());
  assert.equal(a.claims.length, 5);
  assert.ok(a.claims.some((claim) => /Brindlemere/.test(claim.text)));
  assert.doesNotMatch(JSON.stringify(a), /patient|disease|vaccine|symptom|treatment|@/i);
});

test("sanitizeState restores valid storage and rejects or repairs corrupted data", () => {
  const sample = sampleState();
  assert.deepEqual(sanitizeState(JSON.parse(JSON.stringify(sample))), sample);
  for (const bad of [null, "x", 1, {}, { version: 2, claims: [], evidence: [] }]) assert.equal(sanitizeState(bad), null);
  const repaired = sanitizeState({
    version: 1, seq: 1,
    claims: [{ id: "c1", text: "Kept", contradicts: ["c1", "c2", "c404"] }, { id: "c2", text: "Peer" }, { id: "bad", text: "x" }, { id: "c3", text: "" }],
    evidence: [{ id: "e9", claimId: "c1", source: "S", type: "nope" }, { id: "e10", claimId: "c404", source: "S" }, { id: "e11", claimId: "c1", source: "" }],
  });
  assert.deepEqual(repaired.claims.map((claim) => [claim.id, claim.contradicts]), [["c1", ["c2"]], ["c2", ["c1"]]]);
  assert.deepEqual(repaired.evidence.map((item) => [item.id, item.type]), [["e9", "observation"]]);
  assert.equal(repaired.seq, 10, "sequence moves past existing ids so new ids never collide");
  assert.equal(addClaim(repaired, "New").id, "c10");
});

test("exports include scores, review reasons and a synthetic marker", () => {
  const state = sampleState();
  const json = JSON.parse(exportJson(state, "2026-01-01T00:00:00.000Z"));
  assert.equal(json.synthetic, true);
  assert.equal(json.exportedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(json.claims.length, 5);
  assert.equal(typeof json.claims[0].score, "number");
  assert.ok(json.claims.find((claim) => claim.id === "c4").reviewReasons.includes("no-evidence"));
  const md = exportMarkdown(addClaim(state, "Pipe | and *stars*").state);
  assert.match(md, /^# Evidence desk summary \(synthetic demo data\)/);
  assert.match(md, /## Review queue/);
  assert.match(md, /Pipe \\\| and \\\*stars\\\*/);
});

test("evidence desk page renders with external assets, notices and no analytics or inline handlers", () => {
  const html = renderPublicSite("/builds/evidence-desk", env, { host: "product.example.test" });
  assert.match(html, /<title>Evidence desk — live build \| Orkestr<\/title>/);
  assert.match(html, /<script type="module" src="\/builds\/evidence-desk\/evidence-desk-app\.js"><\/script>/);
  assert.match(html, /href="\/builds\/evidence-desk\/evidence-desk\.css"/);
  assert.match(html, /IN-BROWSER SIMULATION/);
  assert.match(html, /Synthetic demo/);
  assert.match(html, /id="ed-reset"/);
  assert.doesNotMatch(html, /\/api\/public\/events/);
  assert.doesNotMatch(html, /\son[a-z]+="/i);
  assert.match(renderPublicSitemap(env), /https:\/\/product\.example\.test\/builds\/evidence-desk/);
});

test("build registry serves only allow-listed assets", () => {
  assert.equal(publicBuilds[0].slug, "evidence-desk");
  assert.equal(publicBuilds[0].mode, "simulation");
  const asset = publicBuildAsset("/builds/evidence-desk/evidence-desk-state.js");
  assert.match(asset.type, /javascript/);
  assert.match(asset.body, /export function scoreClaim/);
  for (const bad of ["/builds/evidence-desk/../../../package.json", "/builds/evidence-desk/secret.js", "/builds/other/evidence-desk.css", "/builds/evidence-desk/"]) assert.equal(publicBuildAsset(bad), null);
  const app = publicBuildAsset("/builds/evidence-desk/evidence-desk-app.js").body;
  assert.doesNotMatch(app, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|innerHTML/);
});
