// Evidence desk browser entry point: state, persistence and actions. Stores
// state in localStorage only and makes no network requests.
import {
  STORAGE_KEY, addClaim, addEvidence, deleteClaim, linkContradiction, recordDecision, removeEvidence,
  reopenClaim, sanitizeState, unlinkContradiction, updateClaim, updateEvidence,
} from "./evidence-desk-state.js";
import { sampleState } from "./evidence-desk-sample.js";
import { exportChecksum, exportFileName, exportJson, exportMarkdown } from "./evidence-desk-export.js";
import { $, applyBarWidths, h, renderClaims, renderDetail, renderQueue, renderSources } from "./evidence-desk-views.js";

const root = $("ed-app");
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

function select(claimId) {
  selectedId = claimId;
  editingEvidenceId = "";
  render();
  $("ed-detail-title")?.focus();
}

const act = {
  select,
  editEvidence(evidenceId, returnTo = "") {
    editingEvidenceId = evidenceId;
    render();
    $(evidenceId ? `ed-edit-${evidenceId}-source` : `ed-evidence-${returnTo}`)?.focus();
  },
  saveEvidence: (claimId, item, fields) => attempt(() => {
    if (!item) return commit(addEvidence(state, claimId, fields).state, "Evidence attached and traced to its source record. Score updated.", "ed-new-evidence-source");
    editingEvidenceId = "";
    commit(updateEvidence(state, item.id, fields), "Evidence updated.", `ed-evidence-${item.id}`);
  }),
  removeEvidence: (evidenceId) => attempt(() => commit(removeEvidence(state, evidenceId), "Evidence removed. The source record is kept.", "ed-detail-title")),
  link: (claimId, otherId) => attempt(() => commit(linkContradiction(state, claimId, otherId), "Claims marked as contradicting each other. Both return to the review queue.", "ed-link-target")),
  unlink: (claimId, otherId) => attempt(() => commit(unlinkContradiction(state, claimId, otherId), "Contradiction link removed.", "ed-detail-title")),
  decide: (claimId, outcome, rationale) => attempt(() => commit(recordDecision(state, claimId, outcome, rationale), "Review decision recorded in the claim history.", "ed-detail-title")),
  reopen: (claimId) => attempt(() => commit(reopenClaim(state, claimId), "Review reopened.", "ed-detail-title")),
  editClaim: (claimId, text) => attempt(() => commit(updateClaim(state, claimId, text), "Claim updated.", "ed-detail-title")),
  deleteClaim(claimId) {
    if (!window.confirm("Delete this claim, its evidence and its history?")) return;
    selectedId = state.claims.find((entry) => entry.id !== claimId)?.id || "";
    attempt(() => commit(deleteClaim(state, claimId), "Claim deleted.", "ed-detail-title"));
  },
};

function render() {
  const ctx = { state, selectedId, editingEvidenceId, act };
  renderQueue(ctx);
  renderClaims(ctx);
  renderDetail(ctx);
  renderSources(ctx);
  applyBarWidths(root);
  $("ed-checksum").textContent = exportChecksum(state);
}

function download(name, type, body) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function focusSourceFromHash() {
  const match = /^#ed-source-(s\d+)$/.exec(location.hash);
  if (match) $(`ed-source-${match[1]}`)?.focus();
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
  commit(fresh, "Demo reset to the fictional sample dataset.", "ed-detail-title");
});
$("ed-export-json").addEventListener("click", () => { download(exportFileName(state, "json"), "application/json", exportJson(state)); announce("JSON export generated in your browser. Same data, same bytes."); });
$("ed-export-md").addEventListener("click", () => { download(exportFileName(state, "md"), "text/markdown", exportMarkdown(state)); announce("Markdown export generated in your browser. Same data, same bytes."); });
window.addEventListener("hashchange", focusSourceFromHash);
// Following a link to the already-current source record fires no hashchange.
root.addEventListener("click", (event) => { if (event.target.closest?.(".ed-source-link")) setTimeout(focusSourceFromHash); });

root.hidden = false;
$("ed-loading")?.remove();
render();
focusSourceFromHash();
