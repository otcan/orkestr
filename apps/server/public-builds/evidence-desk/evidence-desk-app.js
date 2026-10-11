// Evidence desk browser UI. Renders with DOM APIs and textContent only (user
// text is never parsed as HTML), stores state in localStorage and makes no network requests.
import {
  EVIDENCE_TYPES, STANCES, STORAGE_KEY, STRENGTHS,
  addClaim, addEvidence, deleteClaim, exportJson, exportMarkdown, linkContradiction, removeEvidence,
  reviewQueue, reviewReasons, sampleState, sanitizeState, scoreClaim, setReviewed, unlinkContradiction,
  updateClaim, updateEvidence,
} from "./evidence-desk-state.js";

const root = document.getElementById("ed-app");
const $ = (id) => document.getElementById(id);
let state = loadState();
let selectedId = state.claims[0]?.id || "";
let editingEvidenceId = "";
let storageOk = true;

function loadState() {
  try {
    const stored = sanitizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
    if (stored) return stored;
  } catch {
    // Corrupt or blocked storage falls back to the sample dataset.
  }
  return sampleState();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageOk = true;
  } catch {
    storageOk = false;
  }
}

function announce(message) {
  $("ed-status").textContent = storageOk ? message : `${message} (Browser storage is unavailable, so changes last until you reload.)`;
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function options(map, selected, labelOf = (value) => value) {
  return Object.entries(map).map(([value, entry]) => h("option", { value, selected: value === selected, text: labelOf(entry, value) }));
}

function field(label, control, hint = "") {
  return h("label", { class: "ed-field" }, h("span", { text: label }), control, hint ? h("small", { text: hint }) : null);
}

function commit(next, message, focusId = "") {
  state = next;
  save();
  render();
  announce(message);
  if (focusId) $(focusId)?.focus();
}

function attempt(fn) {
  try {
    fn();
  } catch (error) {
    announce(error instanceof Error ? error.message : "That action failed.");
  }
}

function scoreBar(result) {
  const tone = result.score >= 70 ? "high" : result.score <= 30 ? "low" : "mid";
  return h("div", { class: `ed-score ed-score-${tone}` },
    h("div", { class: "ed-score-track", role: "img", "aria-label": `Evidence score ${result.score} out of 100` }, h("span", { "data-width": result.score })),
    h("strong", { text: `${result.score}` }), h("span", { class: "ed-score-label", text: result.label }));
}

function applyBarWidths() {
  // Width is set via CSSOM, which strict style-src CSP allows (unlike inline style attributes).
  for (const bar of root.querySelectorAll("[data-width]")) bar.style.width = `${bar.getAttribute("data-width")}%`;
}

function renderClaims() {
  const list = $("ed-claims");
  list.replaceChildren();
  if (!state.claims.length) list.append(h("li", { class: "ed-empty", text: "No claims yet. Add one above or reset the demo." }));
  for (const claim of state.claims) {
    const result = scoreClaim(state, claim.id);
    const current = claim.id === selectedId;
    list.append(h("li", { class: `ed-claim${current ? " is-selected" : ""}` },
      h("button", { type: "button", class: "ed-claim-open", "aria-current": current ? "true" : null, onclick: () => select(claim.id) },
        h("span", { class: "ed-claim-text", text: claim.text }),
        h("span", { class: "ed-claim-meta", text: `${result.count} evidence · ${claim.contradicts.length} contradiction link${claim.contradicts.length === 1 ? "" : "s"}${claim.reviewed ? " · reviewed" : ""}` })),
      scoreBar(result)));
  }
}

function renderQueue() {
  const list = $("ed-queue");
  const queue = reviewQueue(state);
  $("ed-queue-count").textContent = `${queue.length} waiting`;
  list.replaceChildren();
  if (!queue.length) list.append(h("li", { class: "ed-empty", text: "Nothing waiting for review." }));
  for (const entry of queue) {
    list.append(h("li", {},
      h("button", { type: "button", class: "ed-link-button", onclick: () => select(entry.claimId), text: entry.text }),
      h("ul", { class: "ed-reasons" }, entry.reasons.map((reason) => h("li", { class: `ed-reason ed-reason-${reason.priority}`, text: reason.text })))));
  }
}

function evidenceForm(claimId, item = null) {
  const prefix = item ? `ed-edit-${item.id}` : "ed-new-evidence";
  const source = h("input", { id: `${prefix}-source`, name: "source", required: true, maxlength: 280, autocomplete: "off", value: item?.source || "" });
  const type = h("select", { name: "type" }, options(EVIDENCE_TYPES, item?.type || "measurement", (entry) => entry.label));
  const strength = h("select", { name: "strength" }, options(STRENGTHS, item?.strength || "moderate", (_, value) => value));
  const stance = h("select", { name: "stance" }, options(STANCES, item?.stance || "supports", (entry) => entry));
  const note = h("textarea", { name: "note", rows: 2, maxlength: 500 });
  note.value = item?.note || "";
  const onsubmit = (event) => {
    event.preventDefault();
    const fields = { source: source.value, type: type.value, strength: strength.value, stance: stance.value, note: note.value };
    attempt(() => {
      if (item) {
        editingEvidenceId = "";
        commit(updateEvidence(state, item.id, fields), "Evidence updated. Claim returned to the review queue if it needs attention.", `ed-evidence-${item.id}`);
      } else {
        commit(addEvidence(state, claimId, fields).state, "Evidence attached. Score updated.", "ed-new-evidence-source");
      }
    });
  };
  return h("form", { class: "ed-form ed-evidence-form", onsubmit, "aria-label": item ? "Edit evidence" : "Attach evidence" },
    field("Source (synthetic)", source),
    h("div", { class: "ed-form-row" }, field("Type", type), field("Strength", strength), field("Stance", stance)),
    field("Note (optional)", note),
    h("div", { class: "ed-actions" },
      h("button", { type: "submit", class: "button button-small", text: item ? "Save evidence" : "Attach evidence" }),
      item ? h("button", { type: "button", class: "button button-small button-ghost", text: "Cancel", onclick: () => { editingEvidenceId = ""; render(); $(`ed-evidence-${item.id}`)?.focus(); } }) : null));
}

function renderEvidence(claim) {
  const items = state.evidence.filter((item) => item.claimId === claim.id);
  const list = h("ul", { class: "ed-evidence-list" });
  if (!items.length) list.append(h("li", { class: "ed-empty", text: "No evidence attached yet." }));
  for (const item of items) {
    if (item.id === editingEvidenceId) {
      list.append(h("li", { class: "ed-evidence is-editing" }, evidenceForm(claim.id, item)));
      continue;
    }
    list.append(h("li", { class: `ed-evidence ed-stance-${item.stance}` },
      h("p", { class: "ed-evidence-head" }, h("span", { class: "ed-badge", text: STANCES[item.stance] }), h("strong", { id: `ed-evidence-${item.id}`, tabindex: -1, text: item.source })),
      h("p", { class: "ed-evidence-meta", text: `${EVIDENCE_TYPES[item.type].label} · ${item.strength}` }),
      item.note ? h("p", { class: "ed-evidence-note", text: item.note }) : null,
      h("div", { class: "ed-actions" },
        h("button", { type: "button", class: "button button-small button-ghost", text: "Edit", "aria-label": `Edit evidence: ${item.source}`, onclick: () => { editingEvidenceId = item.id; render(); $(`ed-edit-${item.id}-source`)?.focus(); } }),
        h("button", { type: "button", class: "button button-small button-ghost", text: "Remove", "aria-label": `Remove evidence: ${item.source}`, onclick: () => attempt(() => commit(removeEvidence(state, item.id), "Evidence removed.", "ed-detail-title")) }))));
  }
  return list;
}

function renderLinks(claim) {
  const others = state.claims.filter((other) => other.id !== claim.id && !claim.contradicts.includes(other.id));
  const linked = h("ul", { class: "ed-links" });
  if (!claim.contradicts.length) linked.append(h("li", { class: "ed-empty", text: "No contradiction links." }));
  for (const id of claim.contradicts) {
    const other = state.claims.find((entry) => entry.id === id);
    if (!other) continue;
    linked.append(h("li", {},
      h("button", { type: "button", class: "ed-link-button", text: other.text, onclick: () => select(other.id) }),
      h("button", { type: "button", class: "button button-small button-ghost", text: "Unlink", "aria-label": `Remove contradiction link with: ${other.text}`, onclick: () => commit(unlinkContradiction(state, claim.id, other.id), "Contradiction link removed.", "ed-detail-title") })));
  }
  const picker = h("select", { id: "ed-link-target", disabled: !others.length },
    others.length ? others.map((other) => h("option", { value: other.id, text: other.text })) : h("option", { value: "", text: "No other claims to link" }));
  const form = h("form", { class: "ed-form ed-link-form", onsubmit: (event) => {
    event.preventDefault();
    attempt(() => commit(linkContradiction(state, claim.id, picker.value), "Claims marked as contradicting each other. Both return to the review queue.", "ed-link-target"));
  } }, field("Mark as contradicting", picker), h("button", { type: "submit", class: "button button-small", disabled: !others.length, text: "Link claims" }));
  return [linked, form];
}

function renderDetail() {
  const panel = $("ed-detail");
  panel.replaceChildren();
  const claim = state.claims.find((entry) => entry.id === selectedId);
  if (!claim) {
    panel.append(h("h2", { id: "ed-detail-title", tabindex: -1, text: "Select a claim" }), h("p", { class: "ed-empty", text: "Pick a claim from the list to see its evidence." }));
    return;
  }
  const result = scoreClaim(state, claim.id);
  const reasons = reviewReasons(state, claim.id);
  const text = h("textarea", { id: "ed-claim-text", rows: 3, maxlength: 280, required: true });
  text.value = claim.text;
  panel.append(
    h("p", { class: "ed-kicker", text: "Selected claim" }),
    h("h2", { id: "ed-detail-title", tabindex: -1, text: claim.text }),
    scoreBar(result),
    h("p", { class: "ed-score-explain", text: `Support weight ${result.support} · against ${result.against} · ${result.sources} distinct source${result.sources === 1 ? "" : "s"}` }),
    h("div", { class: "ed-review" },
      h("p", { text: claim.reviewed ? "Marked reviewed." : reasons.length ? `Needs review: ${reasons.map((reason) => reason.text.toLowerCase()).join("; ")}.` : "No open review flags." }),
      h("button", { type: "button", class: "button button-small", text: claim.reviewed ? "Reopen review" : "Mark reviewed", onclick: () => commit(setReviewed(state, claim.id, !claim.reviewed), claim.reviewed ? "Claim reopened for review." : "Claim marked reviewed and removed from the queue.", "ed-detail-title") })),
    h("form", { class: "ed-form", "aria-label": "Edit claim", onsubmit: (event) => { event.preventDefault(); attempt(() => commit(updateClaim(state, claim.id, text.value), "Claim updated.", "ed-detail-title")); } },
      field("Claim text", text),
      h("div", { class: "ed-actions" },
        h("button", { type: "submit", class: "button button-small", text: "Save claim" }),
        h("button", { type: "button", class: "button button-small button-ghost", text: "Delete claim", onclick: () => {
          if (!window.confirm("Delete this claim and its evidence?")) return;
          selectedId = state.claims.find((entry) => entry.id !== claim.id)?.id || "";
          commit(deleteClaim(state, claim.id), "Claim deleted.", "ed-detail-title");
        } }))),
    h("h3", { text: "Evidence" }), renderEvidence(claim),
    h("h3", { text: "Attach evidence" }), evidenceForm(claim.id),
    h("h3", { text: "Contradiction links" }), ...renderLinks(claim));
}

function render() {
  renderQueue();
  renderClaims();
  renderDetail();
  applyBarWidths();
}

function select(claimId) {
  selectedId = claimId;
  editingEvidenceId = "";
  render();
  $("ed-detail-title")?.focus();
}

function download(name, type, body) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  return new Date().toISOString();
}

$("ed-add-claim").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("ed-new-claim");
  attempt(() => {
    const result = addClaim(state, input.value);
    input.value = "";
    selectedId = result.id;
    commit(result.state, "Claim added. Attach evidence to score it.", "ed-detail-title");
  });
});
$("ed-reset").addEventListener("click", () => {
  if (!window.confirm("Reset the demo to the fictional sample dataset? Your changes in this browser will be lost.")) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be blocked; resetting in memory is still correct.
  }
  const fresh = sampleState();
  selectedId = fresh.claims[0]?.id || "";
  editingEvidenceId = "";
  commit(fresh, "Demo reset to the sample dataset.", "ed-detail-title");
});
$("ed-export-json").addEventListener("click", () => { download("evidence-desk-demo.json", "application/json", exportJson(state, stamp())); announce("JSON summary generated in your browser."); });
$("ed-export-md").addEventListener("click", () => { download("evidence-desk-demo.md", "text/markdown", exportMarkdown(state, stamp())); announce("Markdown summary generated in your browser."); });

root.hidden = false;
$("ed-loading")?.remove();
render();
