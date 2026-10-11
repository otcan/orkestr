import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CLAIMS, addClaim, addEvidence, claimHistory, deleteClaim, emptyState, linkContradiction, recordDecision,
  removeEvidence, reopenClaim, sanitizeState, unlinkContradiction, updateClaim, updateEvidence,
} from "../apps/server/public-builds/evidence-desk/evidence-desk-state.js";
import { RUBRIC_NOTE, reviewQueue, scoreClaim } from "../apps/server/public-builds/evidence-desk/evidence-desk-score.js";
import { sampleState } from "../apps/server/public-builds/evidence-desk/evidence-desk-sample.js";
import { checksum, exportFileName, exportJson, exportMarkdown } from "../apps/server/public-builds/evidence-desk/evidence-desk-export.js";
import { renderPublicSite, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";
import { publicBuildAsset, publicBuildAssets } from "../dist/server/apps/server/src/public-site-build-assets.js";
import { publicCatalog } from "../dist/server/apps/server/src/public-site-catalog.js";

const env = { ORKESTR_PUBLIC_SITE_URL: "https://product.example.test", ORKESTR_PUBLIC_APP_URL: "https://app.example.test" };
const at = (time, actor = "Reviewer (test)") => ({ at: time, actor });
const roundTrip = (state) => sanitizeState(JSON.parse(JSON.stringify(state)));

test("claims are created, trimmed, edited and deleted with their evidence, links and history", () => {
  let { id, state } = addClaim(emptyState(), "  Spaced   claim text  ");
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
  assert.equal(claimHistory(state, id).length, 0);
  assert.match(claimHistory(state, second.id).at(-1).text, /was deleted/);
  assert.equal(state.sources.length, 1, "source records outlive the evidence that cited them");
});

test("claim count is bounded", () => {
  let state = emptyState();
  for (let i = 0; i < MAX_CLAIMS; i += 1) state = addClaim(state, `Claim ${i}`).state;
  assert.throws(() => addClaim(state, "One more"), /limited/);
});

test("every evidence item is traced to a source record, reusing records by title", () => {
  let { id, state } = addClaim(emptyState(), "A fictional claim.");
  assert.throws(() => addEvidence(state, id, { source: "" }), /source is required/);
  assert.throws(() => addEvidence(state, "c999", { source: "x" }), /Claim not found/);
  const first = addEvidence(state, id, { source: "Synthetic ledger", type: "rumour", strength: "huge", stance: "maybe", note: "<b>n</b>" });
  state = first.state;
  assert.deepEqual(state.evidence[0], { id: first.id, claimId: id, sourceId: "s1", type: "observation", strength: "moderate", stance: "supports", note: "<b>n</b>" });
  assert.match(state.sources[0].provenance, /synthetic/i);
  state = addEvidence(state, id, { source: "  synthetic LEDGER " }).state;
  assert.equal(state.sources.length, 1);
  assert.equal(state.evidence[1].sourceId, "s1");
  state = updateEvidence(state, first.id, { source: "Another record" });
  assert.equal(state.evidence[0].sourceId, state.sources[1].id);
  for (const item of state.evidence) assert.ok(state.sources.some((source) => source.id === item.sourceId));
});

test("rubric score is 50 without evidence and moves with weighted support and contradiction", () => {
  let { id, state } = addClaim(emptyState(), "A fictional claim.");
  assert.deepEqual(scoreClaim(state, id), { score: 50, support: 0, against: 0, count: 0, sources: 0, label: "No evidence" });
  state = addEvidence(state, id, { source: "Ledger", type: "primary-record", strength: "strong" }).state;
  assert.equal(scoreClaim(state, id).score, 80); // 50 + 50*3/5
  assert.equal(scoreClaim(state, id).label, "Thin evidence");
  const extra = addEvidence(state, id, { source: "Counter", type: "measurement", strength: "moderate", stance: "contradicts" });
  state = extra.state;
  assert.equal(scoreClaim(state, id).score, 57); // 50 + 50*(3-2)/7
  assert.equal(scoreClaim(state, id).label, "Contested");
  state = updateEvidence(state, extra.id, { stance: "supports" });
  assert.equal(scoreClaim(state, id).score, 86);
  assert.equal(scoreClaim(state, id).label, "Well supported");
  state = removeEvidence(state, extra.id);
  assert.equal(scoreClaim(state, id).count, 1);
  assert.match(RUBRIC_NOTE, /Illustrative.*Not a calibrated or scientific confidence measure/);
});

test("contradiction links are symmetric, reject self links and are logged on both claims", () => {
  let state = addClaim(addClaim(emptyState(), "A").state, "B").state;
  assert.throws(() => linkContradiction(state, "c1", "c1"), /itself/);
  state = linkContradiction(state, "c1", "c2");
  assert.equal(linkContradiction(state, "c2", "c1"), state, "linking twice is a no-op");
  assert.deepEqual(state.claims.map((claim) => claim.contradicts), [["c2"], ["c1"]]);
  state = unlinkContradiction(state, "c1", "c2");
  assert.deepEqual(state.claims.map((claim) => claim.contradicts), [[], []]);
  assert.deepEqual(claimHistory(state, "c2").map((entry) => entry.action), ["created", "linked", "unlinked"]);
});

test("review decisions are recorded in history and later changes reopen the claim", () => {
  let state = sampleState();
  assert.equal(state.claims[2].decision.outcome, "accepted");
  assert.ok(!reviewQueue(state).some((entry) => entry.claimId === "c3"));
  assert.throws(() => recordDecision(state, "c2", "maybe"), /outcome/);
  state = recordDecision(state, "c2", "needs-evidence", "Need a second visitor count.");
  const queued = reviewQueue(state).find((entry) => entry.claimId === "c2");
  assert.ok(queued.reasons.some((reason) => reason.code === "reviewer-requested-evidence"));
  state = recordDecision(state, "c2", "rejected", "Counter data contradicts it.");
  assert.ok(!reviewQueue(state).some((entry) => entry.claimId === "c2"));
  state = addEvidence(state, "c2", { source: "Another synthetic log" }).state;
  assert.ok(reviewQueue(state).some((entry) => entry.claimId === "c2"), "new evidence reopens review");
  assert.equal(state.claims[1].decision, null);
  const actions = claimHistory(state, "c2").map((entry) => entry.action);
  assert.deepEqual(actions.slice(-4), ["decision", "decision", "evidence-added", "reopened"]);
  assert.match(claimHistory(state, "c2").at(-1).text, /evidence was added/);
  state = recordDecision(state, "c4", "accepted");
  state = reopenClaim(state, "c4");
  assert.equal(claimHistory(state, "c4").at(-1).text, "Review reopened by the reviewer.");
  const numbers = state.history.map((entry) => entry.n);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "history steps are monotonic");
});

test("history records when, who and what changed for every step", () => {
  let { id, state } = addClaim(emptyState(), "Original text.", at("2026-05-01T08:00:00.000Z", "Analyst (test)"));
  const added = addEvidence(state, id, { source: "Ledger", type: "measurement", strength: "weak" }, at("2026-05-01T08:01:00.000Z"));
  state = recordDecision(added.state, id, "accepted", "Fine.", at("2026-05-01T08:02:00.000Z"));
  assert.deepEqual(state.claims[0].decision, { outcome: "accepted", rationale: "Fine.", n: 3, at: "2026-05-01T08:02:00.000Z", actor: "Reviewer (test)" });
  state = updateEvidence(state, added.id, { source: "Counter", strength: "strong" }, at("2026-05-01T08:03:00.000Z"));
  state = updateClaim(state, id, "New text.", at("2026-05-01T08:04:00.000Z", "Analyst (test)"));
  const history = claimHistory(state, id);
  assert.deepEqual(history.map((entry) => [entry.n, entry.at.slice(11, 16), entry.actor, entry.action]), [
    [1, "08:00", "Analyst (test)", "created"],
    [2, "08:01", "Reviewer (test)", "evidence-added"],
    [3, "08:02", "Reviewer (test)", "decision"],
    [4, "08:03", "Reviewer (test)", "evidence-edited"],
    [5, "08:03", "Reviewer (test)", "reopened"],
    [6, "08:04", "Analyst (test)", "edited"],
  ]);
  assert.match(history[1].text, /New source record S1 created\./);
  assert.deepEqual(history[2].changes, [{ field: "decision", from: "none", to: "Accepted" }]);
  assert.deepEqual(history[3].changes, [{ field: "E2 source", from: "S1 · Ledger", to: "S2 · Counter" }, { field: "E2 strength", from: "weak", to: "strong" }]);
  assert.deepEqual(history[4].changes, [{ field: "decision", from: "Accepted", to: "none" }]);
  assert.deepEqual(history[5].changes, [{ field: "text", from: "Original text.", to: "New text." }]);
  const fallback = claimHistory(addClaim(emptyState(), "x", { at: "yesterday", actor: "" }).state, "c1")[0];
  assert.deepEqual([fallback.at, fallback.actor], ["", "You (this browser)"]);
  const md = exportMarkdown(state);
  assert.match(md, /- Step 4 · 2026-05-01T08:03:00\.000Z · Reviewer \(test\): Evidence E2 .* edited\.\n  - E2 source: “S1 · Ledger” → “S2 · Counter”\n  - E2 strength: “weak” → “strong”/);
});

test("sample dataset is fictional, deterministic, traceable and resettable", () => {
  const a = sampleState();
  assert.deepEqual(a, sampleState());
  assert.equal(a.claims.length, 5);
  assert.equal(a.sources.length, 8);
  assert.ok(a.sources.every((source) => /synthetic/i.test(source.kind) && /fictional/i.test(source.provenance)));
  assert.ok(a.evidence.every((item) => a.sources.some((source) => source.id === item.sourceId)));
  assert.ok(a.history.every((entry) => entry.actor === "Sample reviewer (fictional)" && entry.at.startsWith("2026-03-02T09:")));
  assert.doesNotMatch(JSON.stringify(a), /patient|disease|vaccine|symptom|treatment|@|https?:/i);
});

test("sanitizeState restores valid storage and rejects or repairs corrupted data", () => {
  const sample = sampleState();
  assert.deepEqual(roundTrip(sample), sample);
  for (const bad of [null, "x", 1, {}, { version: 2, claims: [], evidence: [], sources: [], history: [] }]) assert.equal(sanitizeState(bad), null);
  const repaired = sanitizeState({
    version: 3, seq: 1, hseq: 1,
    sources: [{ id: "s7", title: "Record" }, { id: "x", title: "bad" }],
    claims: [{ id: "c1", text: "Kept", contradicts: ["c1", "c2", "c404"], decision: { outcome: "bogus" } }, { id: "c2", text: "Peer", decision: { outcome: "accepted", n: 3 } }, { id: "bad", text: "x" }],
    evidence: [{ id: "e9", claimId: "c1", sourceId: "s7", type: "nope" }, { id: "e10", claimId: "c404", sourceId: "s7" }, { id: "e11", claimId: "c1", sourceId: "s404" }],
    history: [{ n: 4, at: "not a time", actor: "", claimId: "c1", action: "created", text: "x", changes: [{ field: "text", from: "", to: "x" }, { from: "no field" }] }, { n: "5", claimId: "c1" }, { n: 6, claimId: "c404" }],
  });
  assert.deepEqual(repaired.claims.map((claim) => [claim.id, claim.contradicts, claim.reviewed]), [["c1", ["c2"], false], ["c2", ["c1"], true]]);
  assert.deepEqual(repaired.evidence.map((item) => [item.id, item.type]), [["e9", "observation"]]);
  assert.deepEqual(repaired.history, [{ n: 4, at: "", actor: "You (this browser)", claimId: "c1", action: "created", text: "x", changes: [{ field: "text", from: "", to: "x" }] }]);
  assert.equal(repaired.seq, 10);
  assert.equal(repaired.hseq, 5);
  assert.equal(repaired.sseq, 8);
  assert.equal(addClaim(repaired, "New").id, "c10");
});

test("exports are reproducible: same data gives byte-identical JSON and Markdown", () => {
  const replay = () => {
    let state = sampleState();
    state = addEvidence(state, "c4", { source: "Brindlemere loan ledger, Jan–May", type: "primary-record", strength: "weak", stance: "contradicts" }, at("2026-04-01T10:00:00.000Z")).state;
    return recordDecision(state, "c4", "needs-evidence", "Check seasonal mix.", at("2026-04-01T10:05:00.000Z"));
  };
  const a = replay();
  const b = replay();
  assert.equal(exportJson(a), exportJson(b));
  assert.equal(exportMarkdown(a), exportMarkdown(b));
  assert.equal(exportJson(roundTrip(a)), exportJson(a), "persisting and reloading does not change the export");
  assert.equal(exportMarkdown(roundTrip(a)), exportMarkdown(a));
  assert.equal(exportFileName(a, "json"), exportFileName(b, "json"));
  assert.notEqual(exportJson(a), exportJson(sampleState()));
  const json = exportJson(sampleState());
  assert.doesNotMatch(json, /exportedAt|userAgent|navigator/);
  assert.ok([...json.matchAll(/"at": "([^"]*)"/g)].every(([, value]) => value.startsWith("2026-03-02T09:")), "only the sample's fixed history times appear");
  const parsed = JSON.parse(json);
  const { checksum: embedded, ...rest } = parsed;
  assert.equal(embedded, checksum(JSON.stringify(rest, null, 2)), "embedded checksum covers the payload");
  assert.equal(embedded, "fnv1a32-effa441c", "golden checksum for the sample; update only on an intended format change");
});

test("exports carry provenance, rubric caveat, source links and decision history", () => {
  const state = sampleState();
  const json = JSON.parse(exportJson(state));
  assert.equal(json.synthetic, true);
  assert.match(json.dataNotice, /invented town/);
  assert.match(json.rubric.note, /Not a calibrated or scientific confidence measure/);
  assert.equal(json.sources.length, 8);
  assert.deepEqual(json.sources[0].citedBy, ["e6"]);
  const c3 = json.claims.find((claim) => claim.id === "c3");
  assert.equal(c3.decision.outcome, "accepted");
  assert.equal(typeof c3.rubricScore, "number");
  assert.ok(c3.history.some((entry) => entry.action === "decision"));
  assert.ok(json.claims.find((claim) => claim.id === "c4").reviewReasons.includes("no-evidence"));
  const md = exportMarkdown(addClaim(state, "Pipe | and *stars*").state);
  assert.match(md, /^# Evidence desk summary — fictional demo data/);
  assert.match(md, /Not a calibrated or scientific confidence measure/);
  assert.match(md, /\[S1 · Brindlemere loan ledger, Jan–May\]\(#s1\)/);
  assert.match(md, /<a id="s1"><\/a>/);
  assert.match(md, /Decision history:/);
  assert.match(md, /Pipe \\\| and \\\*stars\\\*/);
  assert.match(md, /\n---\nChecksum: fnv1a32-[0-9a-f]{8}\n$/);
});

test("evidence desk page renders with external assets, prominent fictional notice and no analytics or inline handlers", () => {
  const html = renderPublicSite("/builds/evidence-desk", env, { host: "product.example.test" });
  assert.match(html, /<title>Evidence desk — live build \| Orkestr<\/title>/);
  assert.match(html, /<script type="module" src="\/builds\/evidence-desk\/evidence-desk-app\.js"><\/script>/);
  assert.match(html, /href="\/builds\/evidence-desk\/evidence-desk\.css"/);
  assert.match(html, /IN-BROWSER SIMULATION · FICTIONAL DATA/);
  assert.match(html, /Fictional topic, synthetic records\./);
  assert.match(html, /not a measure of scientific confidence/);
  assert.match(html, /id="ed-sources"/);
  assert.doesNotMatch(html, /\/api\/public\/events|data-event=|Book a project call/);
  assert.match(html, /<a href="\/builds" aria-current="true">Live builds<\/a>/);
  assert.doesNotMatch(html, /\son[a-z]+="/i);
  assert.match(renderPublicSitemap(env), /https:\/\/product\.example\.test\/builds\/evidence-desk/);
});

test("catalog lists the evidence desk as a live simulation and only allow-listed assets are served", () => {
  const entry = publicCatalog.find((item) => item.slug === "evidence-desk");
  assert.equal(entry.status, "live");
  assert.equal(entry.evidence, "simulation");
  assert.equal(entry.render(env).canonicalPath, "/builds/evidence-desk");
  const index = renderPublicSite("/builds", env, { host: "product.example.test" });
  assert.match(index, /<a href="\/builds\/evidence-desk">Evidence desk<\/a>/);
  const assets = publicBuildAssets["evidence-desk"];
  for (const name of Object.keys(assets)) {
    const asset = publicBuildAsset(`/builds/evidence-desk/${name}`);
    assert.ok(asset, name);
    assert.doesNotMatch(asset.body, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|innerHTML|import\(|https?:\/\//, name);
    for (const [, imported] of asset.body.matchAll(/from "\.\/([^"]+)"/g)) assert.ok(assets[imported], `${name} imports unserved ${imported}`);
  }
  for (const bad of ["/builds/evidence-desk/../../../package.json", "/builds/evidence-desk/secret.js", "/builds/other/evidence-desk.css", "/builds/evidence-desk/"]) assert.equal(publicBuildAsset(bad), null);
});

test("evidence desk loads no analytics beacon and its page code makes no network requests", () => {
  const html = renderPublicSite("/builds/evidence-desk", env, { host: "product.example.test" });
  assert.doesNotMatch(html, /\/api\/public\/events|sendBeacon|orkestrTrack|data-event=|data-view-event=/);
  const assets = publicBuildAssets["evidence-desk"];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) {
    if (/type="application\/ld\+json"/.test(attrs)) continue; // structured data, not executable
    const src = /^\s*type="module" src="\/builds\/evidence-desk\/([a-z0-9.-]+)"\s*$/.exec(attrs);
    assert.ok(src && assets[src[1]], `unexpected script tag: <script${attrs}>`);
    assert.equal(body.trim(), "", "no inline executable script");
  }
  const network = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\s*\(|new\s+Image\b|serviceWorker|\.src\s*=|https?:\/\/|\/api\/|data-event|data-view-event/;
  for (const name of Object.keys(assets)) assert.doesNotMatch(publicBuildAsset(`/builds/evidence-desk/${name}`).body, network, name);
});
