// Evidence desk DOM builders. textContent only: user text is never parsed as HTML.
// Each render function receives a ctx: { state, selectedId, editingEvidenceId, act }.
import { EVIDENCE_TYPES, OUTCOMES, STANCES, STRENGTHS, citations, claimHistory, sourceLabel } from "./evidence-desk-state.js";
import { RUBRIC_NOTE, reviewQueue, reviewReasons, scoreClaim } from "./evidence-desk-score.js";

export const $ = (id) => document.getElementById(id);

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child);
  return node;
}

function options(map, selected, labelOf) {
  return Object.entries(map).map(([value, entry]) => h("option", { value, selected: value === selected, text: labelOf(entry, value) }));
}

function field(label, control, hint = "") {
  return h("label", { class: "ed-field" }, h("span", { text: label }), control, hint ? h("small", { text: hint }) : null);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const button = (text, onclick, extra = {}) => h("button", { type: "button", class: "button button-small button-ghost", text, onclick, ...extra });

function scoreBar(result) {
  const tone = result.score >= 70 ? "high" : result.score <= 30 ? "low" : "mid";
  return h("div", { class: `ed-score ed-score-${tone}` },
    h("div", { class: "ed-score-track", role: "img", "aria-label": `Illustrative rubric score ${result.score} out of 100` }, h("span", { "data-width": result.score })),
    h("strong", { text: `${result.score}` }), h("span", { class: "ed-score-label", text: result.label }));
}

export function applyBarWidths(root) {
  // Width is set via CSSOM, which a strict style-src CSP allows (unlike inline style attributes).
  for (const bar of root.querySelectorAll("[data-width]")) bar.style.width = `${bar.getAttribute("data-width")}%`;
}

function sourceLink(state, sourceId) {
  const source = state.sources.find((entry) => entry.id === sourceId);
  return h("a", { class: "ed-source-link", href: `#ed-source-${sourceId}`, text: source ? sourceLabel(source) : sourceId });
}

export function renderClaims({ state, selectedId, act }) {
  const list = $("ed-claims");
  list.replaceChildren();
  if (!state.claims.length) list.append(h("li", { class: "ed-empty", text: "No claims yet. Add one above or reset the demo." }));
  for (const claim of state.claims) {
    const result = scoreClaim(state, claim.id);
    const current = claim.id === selectedId;
    list.append(h("li", { class: `ed-claim${current ? " is-selected" : ""}` },
      h("button", { type: "button", class: "ed-claim-open", "aria-current": current ? "true" : null, onclick: () => act.select(claim.id) },
        h("span", { class: "ed-claim-text", text: claim.text }),
        h("span", { class: "ed-claim-meta", text: `${claim.id.toUpperCase()} · ${plural(result.count, "evidence item")} · ${plural(claim.contradicts.length, "contradiction link")}${claim.decision ? ` · ${OUTCOMES[claim.decision.outcome].toLowerCase()}` : ""}` })),
      scoreBar(result)));
  }
}

export function renderQueue({ state, act }) {
  const list = $("ed-queue");
  const queue = reviewQueue(state);
  $("ed-queue-count").textContent = `${queue.length} waiting`;
  list.replaceChildren();
  if (!queue.length) list.append(h("li", { class: "ed-empty", text: "Nothing waiting for review." }));
  for (const entry of queue) {
    list.append(h("li", {},
      h("button", { type: "button", class: "ed-link-button", onclick: () => act.select(entry.claimId), text: entry.text }),
      h("ul", { class: "ed-reasons" }, entry.reasons.map((reason) => h("li", { class: `ed-reason ed-reason-${reason.priority}`, text: reason.text })))));
  }
}

export function renderSources({ state, act }) {
  const list = $("ed-sources");
  $("ed-source-count").textContent = plural(state.sources.length, "record");
  $("ed-source-options").replaceChildren(...state.sources.map((source) => h("option", { value: source.title })));
  list.replaceChildren();
  if (!state.sources.length) list.append(h("li", { class: "ed-empty", text: "No source records yet." }));
  for (const source of state.sources) {
    const cited = citations(state, source.id);
    list.append(h("li", { id: `ed-source-${source.id}`, class: "ed-source", tabindex: -1 },
      h("p", { class: "ed-evidence-head" }, h("span", { class: "ed-badge ed-badge-synthetic", text: "Synthetic" }), h("strong", { text: sourceLabel(source) })),
      h("p", { class: "ed-evidence-meta", text: source.kind }),
      source.excerpt ? h("blockquote", { class: "ed-excerpt", text: source.excerpt }) : null,
      h("p", { class: "ed-provenance", text: `Provenance: ${source.provenance}` }),
      h("p", { class: "ed-evidence-meta" }, cited.length ? "Cited by: " : "Not cited by any evidence.",
        cited.map((item, index) => [index ? ", " : "", h("button", { type: "button", class: "ed-link-button", text: `${item.id.toUpperCase()} on ${item.claimId.toUpperCase()}`, onclick: () => act.select(item.claimId) })]))));
  }
}

function evidenceForm(ctx, claimId, item = null) {
  const { state, act } = ctx;
  const prefix = item ? `ed-edit-${item.id}` : "ed-new-evidence";
  const current = item ? state.sources.find((source) => source.id === item.sourceId)?.title : "";
  const source = h("input", { id: `${prefix}-source`, name: "source", required: true, maxlength: 280, autocomplete: "off", list: "ed-source-options", value: current || "" });
  const type = h("select", { name: "type" }, options(EVIDENCE_TYPES, item?.type || "measurement", (entry) => entry.label));
  const strength = h("select", { name: "strength" }, options(STRENGTHS, item?.strength || "moderate", (_, value) => value));
  const stance = h("select", { name: "stance" }, options(STANCES, item?.stance || "supports", (entry) => entry));
  const note = h("textarea", { name: "note", rows: 2, maxlength: 500 });
  note.value = item?.note || "";
  const onsubmit = (event) => {
    event.preventDefault();
    act.saveEvidence(claimId, item, { source: source.value, type: type.value, strength: strength.value, stance: stance.value, note: note.value });
  };
  return h("form", { class: "ed-form ed-evidence-form", onsubmit, "aria-label": item ? "Edit evidence" : "Attach evidence" },
    field("Source record", source, "Pick an existing source record or type a new title to create one."),
    h("div", { class: "ed-form-row" }, field("Type", type), field("Strength", strength), field("Stance", stance)),
    field("Note (optional)", note),
    h("div", { class: "ed-actions" },
      h("button", { type: "submit", class: "button button-small", text: item ? "Save evidence" : "Attach evidence" }),
      item ? button("Cancel", () => act.editEvidence("", item.id)) : null));
}

function renderEvidence(ctx, claim) {
  const { state, editingEvidenceId, act } = ctx;
  const items = state.evidence.filter((item) => item.claimId === claim.id);
  const list = h("ul", { class: "ed-evidence-list" });
  if (!items.length) list.append(h("li", { class: "ed-empty", text: "No evidence attached yet." }));
  for (const item of items) {
    if (item.id === editingEvidenceId) {
      list.append(h("li", { class: "ed-evidence is-editing" }, evidenceForm(ctx, claim.id, item)));
      continue;
    }
    list.append(h("li", { class: `ed-evidence ed-stance-${item.stance}` },
      h("p", { class: "ed-evidence-head" }, h("span", { class: "ed-badge", text: STANCES[item.stance] }), h("strong", { id: `ed-evidence-${item.id}`, tabindex: -1, text: item.id.toUpperCase() }), sourceLink(state, item.sourceId)),
      h("p", { class: "ed-evidence-meta", text: `${EVIDENCE_TYPES[item.type].label} · ${item.strength}` }),
      item.note ? h("p", { class: "ed-evidence-note", text: item.note }) : null,
      h("div", { class: "ed-actions" },
        button("Edit", () => act.editEvidence(item.id), { "aria-label": `Edit evidence ${item.id.toUpperCase()}` }),
        button("Remove", () => act.removeEvidence(item.id), { "aria-label": `Remove evidence ${item.id.toUpperCase()}` }))));
  }
  return list;
}

function renderLinks({ state, act }, claim) {
  const others = state.claims.filter((other) => other.id !== claim.id && !claim.contradicts.includes(other.id));
  const linked = h("ul", { class: "ed-links" });
  if (!claim.contradicts.length) linked.append(h("li", { class: "ed-empty", text: "No contradiction links." }));
  for (const id of claim.contradicts) {
    const other = state.claims.find((entry) => entry.id === id);
    if (!other) continue;
    linked.append(h("li", {},
      h("button", { type: "button", class: "ed-link-button", text: other.text, onclick: () => act.select(other.id) }),
      button("Unlink", () => act.unlink(claim.id, other.id), { "aria-label": `Remove contradiction link with: ${other.text}` })));
  }
  const picker = h("select", { id: "ed-link-target", disabled: !others.length },
    others.length ? others.map((other) => h("option", { value: other.id, text: other.text })) : h("option", { value: "", text: "No other claims to link" }));
  const form = h("form", { class: "ed-form ed-link-form", onsubmit: (event) => { event.preventDefault(); act.link(claim.id, picker.value); } },
    field("Mark as contradicting", picker), h("button", { type: "submit", class: "button button-small", disabled: !others.length, text: "Link claims" }));
  return [linked, form];
}

function renderDecision({ state, act }, claim) {
  const reasons = reviewReasons(state, claim.id);
  const status = claim.decision
    ? `Decision: ${OUTCOMES[claim.decision.outcome]}${claim.decision.rationale ? ` — ${claim.decision.rationale}` : ""} (${claim.decision.actor}, ${formatTime(claim.decision.at)})`
    : reasons.length ? `Needs review: ${reasons.map((reason) => reason.text.toLowerCase()).join("; ")}.` : "No open review flags.";
  const outcome = h("select", { id: "ed-decision-outcome", name: "outcome" }, options(OUTCOMES, "accepted", (entry) => entry));
  const rationale = h("textarea", { id: "ed-decision-rationale", rows: 2, maxlength: 500 });
  return h("div", { class: "ed-review" },
    h("p", { class: "ed-review-status", text: status }),
    claim.decision ? button("Reopen review", () => act.reopen(claim.id), { class: "button button-small", id: "ed-reopen" }) : null,
    h("form", { class: "ed-form ed-decision-form", "aria-label": "Record review decision", onsubmit: (event) => { event.preventDefault(); act.decide(claim.id, outcome.value, rationale.value); } },
      h("div", { class: "ed-form-row ed-form-row-2" }, field("Review outcome", outcome), field("Rationale (optional)", rationale)),
      h("div", { class: "ed-actions" }, h("button", { type: "submit", class: "button button-small", text: "Record decision" }))));
}

export function formatTime(at) {
  return at ? `${at.slice(0, 10)} ${at.slice(11, 16)} UTC` : "time not recorded";
}

export function formatChange(change) {
  const show = (value) => (value ? `“${value}”` : "none");
  return `${change.field}: ${show(change.from)} → ${show(change.to)}`;
}

function renderHistory(state, claim) {
  const entries = claimHistory(state, claim.id);
  return h("ol", { class: "ed-history", reversed: true },
    entries.length ? [...entries].reverse().map((entry) => h("li", { value: entry.n },
      h("span", { class: "ed-history-step" }, `Step ${entry.n} · `, h("time", { datetime: entry.at || null, text: formatTime(entry.at) }), ` · ${entry.actor}`),
      h("span", { text: entry.text }),
      entry.changes.length ? h("ul", { class: "ed-changes" }, entry.changes.map((change) => h("li", { text: formatChange(change) }))) : null))
      : h("li", { class: "ed-empty", text: "No recorded steps." }));
}

export function renderDetail(ctx) {
  const { state, selectedId, act } = ctx;
  const panel = $("ed-detail");
  panel.replaceChildren();
  const claim = state.claims.find((entry) => entry.id === selectedId);
  if (!claim) {
    panel.append(h("h2", { id: "ed-detail-title", tabindex: -1, text: "Select a claim" }), h("p", { class: "ed-empty", text: "Pick a claim from the list to see its evidence." }));
    return;
  }
  const result = scoreClaim(state, claim.id);
  const text = h("textarea", { id: "ed-claim-text", rows: 3, maxlength: 280, required: true });
  text.value = claim.text;
  panel.append(
    h("p", { class: "ed-kicker", text: `Selected claim ${claim.id.toUpperCase()} · fictional` }),
    h("h2", { id: "ed-detail-title", tabindex: -1, text: claim.text }),
    scoreBar(result),
    h("p", { class: "ed-score-explain", text: `Support weight ${result.support} · against ${result.against} · ${plural(result.sources, "distinct source record")}` }),
    h("p", { class: "ed-rubric-note", text: RUBRIC_NOTE }),
    renderDecision(ctx, claim),
    h("form", { class: "ed-form", "aria-label": "Edit claim", onsubmit: (event) => { event.preventDefault(); act.editClaim(claim.id, text.value); } },
      field("Claim text", text),
      h("div", { class: "ed-actions" },
        h("button", { type: "submit", class: "button button-small", text: "Save claim" }),
        button("Delete claim", () => act.deleteClaim(claim.id)))),
    h("h3", { text: "Evidence" }), renderEvidence(ctx, claim),
    h("h3", { text: "Attach evidence" }), evidenceForm(ctx, claim.id),
    h("h3", { text: "Contradiction links" }), ...renderLinks(ctx, claim),
    h("h3", { text: "Decision history" }), renderHistory(state, claim));
}
