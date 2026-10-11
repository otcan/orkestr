// Browser UI for the synthetic customer portal demo. Entries stay in this
// browser (localStorage). After the page and its static assets have loaded, the
// code sends nothing back: no fetch/XHR/beacon/WebSocket, no analytics.
import {
  MAX_LINE_QUANTITY,
  MAX_REASON_LENGTH,
  ROLES,
  STATUS,
  STATUS_LABELS,
  STORAGE_KEY,
  evaluateRules,
  findAccount,
  findProduct,
  parseState,
  pendingOrders,
  serializeState,
  transition,
  validateDraft,
} from "./workflow.js";

const root = document.getElementById("portal-app");

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === "text") node.textContent = String(value);
    else if (key === "className") node.className = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function money(value) {
  return `${Number(value || 0).toLocaleString("en-US")} EUR`;
}

function time(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const storage = (() => {
  try {
    const probe = `${STORAGE_KEY}-probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
})();

let state = parseState(storage ? storage.getItem(STORAGE_KEY) : "");
// draft holds raw text per SKU; submissionId identifies one submission of that draft
// so repeated clicks or replays never create a second order.
let draft = {};
let submissionId = newSubmissionId();
let lastSubmitted = null;
let showErrors = false;

function newSubmissionId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resetDraft() {
  draft = {};
  submissionId = newSubmissionId();
  lastSubmitted = null;
  showErrors = false;
}

function persist() {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, serializeState(state));
  } catch {
    announce("This browser refused to save demo state; changes last until you leave the page.");
  }
}

function announce(message, focus = false) {
  const status = root.querySelector("#portal-status");
  status.textContent = message;
  if (focus) status.focus();
}

function dispatch(action, message, focus = false) {
  const result = transition(state, { role: state.role, ...action });
  if (!result.ok) {
    announce(result.error, true);
    return null;
  }
  state = result.state;
  persist();
  render();
  if (message) announce(typeof message === "function" ? message(result) : message, focus);
  return result;
}

function statusBadge(order) {
  return h("span", { className: `portal-badge status-${order.status}`, text: STATUS_LABELS[order.status] || order.status });
}

function checksList(checks) {
  return h("ul", { className: "portal-checks" }, checks.map((check) => h("li", { className: check.passed ? "pass" : "fail" }, [
    h("span", { className: "portal-check-mark", "aria-hidden": "true", text: check.passed ? "✓" : "!" }),
    h("strong", { text: `${check.label}: ${check.passed ? "pass" : "exception"}` }),
    h("span", { text: ` ${check.detail}` }),
  ])));
}

function linesTable(order) {
  return h("table", { className: "portal-lines" }, [
    h("caption", { className: "visually-hidden", text: `Lines for ${order.id}` }),
    h("thead", {}, h("tr", {}, ["Product", "Qty", "Reserved", "Backordered"].map((label) => h("th", { scope: "col", text: label })))),
    h("tbody", {}, order.lines.map((line) => h("tr", {}, [
      h("td", { text: `${findProduct(state, line.sku)?.name || line.sku} (${line.sku})` }),
      h("td", { text: line.quantity }),
      h("td", { text: line.reserved ?? "–" }),
      h("td", { text: line.backordered ?? "–" }),
    ]))),
  ]);
}

function timeline(order) {
  return h("ol", { className: "portal-timeline", "aria-label": `Timeline for ${order.id}` }, order.timeline.map((entry) => h("li", {}, [
    h("time", { datetime: entry.at, text: time(entry.at) }),
    h("strong", { text: ` ${entry.event}` }),
    h("span", { className: "portal-actor", text: ` · ${entry.actor}` }),
    h("p", { text: entry.detail }),
  ])));
}

function orderCard(order, actions = null) {
  const account = findAccount(state, order.accountId);
  return h("article", { className: "portal-order", "data-order": order.id }, [
    h("header", {}, [
      h("h4", { text: order.id }),
      statusBadge(order),
    ]),
    h("p", { className: "portal-order-meta", text: `${account?.name || order.accountId} · ${money(order.total)}` }),
    order.decision ? h("p", { className: "portal-decision", text: `Decision by ${order.decision.by}: ${order.decision.outcome}${order.decision.reason ? ` — ${order.decision.reason}` : ""}` }) : null,
    actions,
    h("details", {}, [
      h("summary", { text: "Lines, rule checks and timeline" }),
      linesTable(order),
      checksList(order.checks),
      timeline(order),
    ]),
  ]);
}

function previewChildren() {
  const { lines, errors } = validateDraft(state, draft);
  if (Object.keys(errors).length) return [h("p", { text: "Fix the highlighted quantities to see the rule check." })];
  if (!lines.length) return [h("p", { text: "Enter quantities to see the rule check before submitting." })];
  const preview = evaluateRules(state, state.accountId, lines);
  return [
    h("p", { text: `Order total ${money(preview.total)} · ${preview.exceptions.length ? "will pause for an approver" : "would be auto-approved"}` }),
    checksList(preview.checks),
  ];
}

function fieldError(sku, message) {
  const input = root.querySelector(`input[data-sku="${CSS.escape(sku)}"]`);
  const slot = root.querySelector(`#qty-error-${CSS.escape(sku)}`);
  if (!input || !slot) return;
  slot.textContent = message || "";
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function refreshValidation() {
  const result = validateDraft(state, draft);
  for (const product of state.products) fieldError(product.sku, result.errors[product.sku] || "");
  const formError = root.querySelector("#portal-form-error");
  if (formError) formError.textContent = showErrors ? result.formError : "";
  root.querySelector(".portal-preview")?.replaceChildren(...previewChildren());
  return result;
}

function renderOrderForm() {
  const account = findAccount(state, state.accountId);
  const { errors } = validateDraft(state, draft);
  return h("form", { id: "portal-order-form", className: "portal-form", novalidate: true }, [
    h("label", { for: "portal-account", text: "Ordering as sample account" }),
    h("select", { id: "portal-account", name: "account" }, state.accounts.map((item) => h("option", { value: item.id, selected: item.id === state.accountId, text: item.name }))),
    h("p", { className: "portal-hint", text: account ? `Credit limit ${money(account.creditLimit)} · open balance ${money(account.openBalance)}` : "" }),
    h("table", { className: "portal-catalog" }, [
      h("caption", { text: "Sample catalogue" }),
      h("thead", {}, h("tr", {}, ["Product", "Unit price", "In stock", "Quantity"].map((label) => h("th", { scope: "col", text: label })))),
      h("tbody", {}, state.products.map((product) => h("tr", {}, [
        h("th", { scope: "row" }, [product.name, h("span", { className: "portal-sku", text: ` ${product.sku}` })]),
        h("td", { "data-label": "Unit price", text: money(product.unitPrice) }),
        h("td", { "data-label": "In stock", text: product.stock }),
        h("td", { "data-label": "Quantity" }, [
          h("input", {
            type: "text", inputmode: "numeric", autocomplete: "off", maxlength: "6",
            name: `qty-${product.sku}`, "data-sku": product.sku, value: draft[product.sku] || "",
            "aria-label": `Quantity of ${product.name} (0 to ${MAX_LINE_QUANTITY})`,
            "aria-describedby": `qty-error-${product.sku}`, "aria-invalid": errors[product.sku] ? "true" : null,
          }),
          h("span", { className: "portal-field-error", id: `qty-error-${product.sku}`, text: errors[product.sku] || "" }),
        ]),
      ]))),
    ]),
    h("div", { className: "portal-preview", "aria-live": "polite" }, previewChildren()),
    h("p", { className: "portal-field-error", id: "portal-form-error", role: "alert" }),
    h("button", { type: "submit", className: "button", text: "Submit order" }),
  ]);
}

function renderCustomer() {
  const mine = state.orders.filter((order) => order.accountId === state.accountId);
  return h("div", { className: "portal-panel", id: "customer-panel" }, [
    h("h3", { text: "Place an order" }),
    renderOrderForm(),
    h("h3", { text: `Orders for this account (${mine.length})` }),
    mine.length
      ? h("div", { className: "portal-orders" }, mine.map((order) => orderCard(order, order.status === STATUS.pendingApproval
        ? h("div", { className: "portal-actions" }, h("button", { type: "button", className: "button button-outline", "data-action": "cancel", "data-order": order.id, text: `Cancel ${order.id}` }))
        : null)))
      : h("p", { className: "portal-empty", text: "No orders yet. Try a small order, then one that exceeds stock or credit." }),
  ]);
}

function renderApprover() {
  const queue = pendingOrders(state);
  const decided = state.orders.filter((order) => order.status !== STATUS.pendingApproval);
  return h("div", { className: "portal-panel", id: "approver-panel" }, [
    h("h3", { text: `Approval queue (${queue.length})` }),
    queue.length
      ? h("div", { className: "portal-orders" }, queue.map((order) => {
        const reasonId = `reason-${order.id}`;
        return orderCard(order, h("div", { className: "portal-actions" }, [
          h("p", { className: "portal-exceptions", text: `Exceptions: ${order.exceptions.join(", ")}` }),
          h("label", { for: reasonId, text: "Decision note (required to reject, stays in this browser)" }),
          h("input", { id: reasonId, type: "text", maxlength: String(MAX_REASON_LENGTH), autocomplete: "off", "data-reason": order.id }),
          h("div", { className: "portal-buttons" }, [
            h("button", { type: "button", className: "button", "data-action": "approve", "data-order": order.id, text: `Approve ${order.id}` }),
            h("button", { type: "button", className: "button button-outline", "data-action": "reject", "data-order": order.id, text: `Reject ${order.id}` }),
          ]),
        ]));
      }))
      : h("p", { className: "portal-empty", text: "Nothing is waiting. Switch to the customer role and submit an order that breaks a rule." }),
    h("h3", { text: `Decided orders (${decided.length})` }),
    decided.length ? h("div", { className: "portal-orders" }, decided.map((order) => orderCard(order))) : h("p", { className: "portal-empty", text: "No decisions yet." }),
  ]);
}

function renderAudit() {
  const rows = [...state.audit].reverse();
  return h("section", { className: "portal-audit", "aria-labelledby": "portal-audit-title" }, [
    h("h3", { id: "portal-audit-title", text: `Audit log (${rows.length} ${rows.length === 1 ? "entry" : "entries"}, newest first)` }),
    h("div", { className: "portal-table-scroll", tabindex: "0", role: "region", "aria-label": "Audit log table" }, h("table", {}, [
      h("thead", {}, h("tr", {}, ["#", "Time", "Role", "Action", "Order", "Detail"].map((label) => h("th", { scope: "col", text: label })))),
      h("tbody", {}, rows.map((entry) => h("tr", {}, [
        h("td", { text: entry.seq }), h("td", {}, h("time", { datetime: entry.at, text: time(entry.at) })),
        h("td", { text: entry.role }), h("td", { text: entry.action.replace(/_/g, " ") }),
        h("td", { text: entry.orderId || "–" }), h("td", { text: entry.detail }),
      ]))),
    ])),
  ]);
}

function render() {
  for (const radio of root.querySelectorAll('input[name="portal-role"]')) radio.checked = radio.value === state.role;
  const pending = pendingOrders(state).length;
  root.querySelector("#portal-pending-count").textContent = pending ? ` (${pending} waiting)` : "";
  const view = root.querySelector("#portal-view");
  const active = document.activeElement;
  const focusKey = active && root.contains(active) ? (active.getAttribute("data-sku") || active.id || "") : "";
  view.replaceChildren(state.role === ROLES.approver ? renderApprover() : renderCustomer(), renderAudit());
  if (focusKey) {
    const target = view.querySelector(`[data-sku="${CSS.escape(focusKey)}"]`) || view.querySelector(`#${CSS.escape(focusKey)}`);
    if (target) target.focus();
  }
  root.querySelector("#portal-storage-note").textContent = storage
    ? "State is saved only in this browser (localStorage) and survives a reload."
    : "This browser blocks localStorage, so demo state resets when you leave the page.";
}

root.addEventListener("change", (event) => {
  const target = event.target;
  if (target.name === "portal-role") {
    dispatch({ type: "switch_role", role: target.value }, target.value === ROLES.approver ? "Viewing as approver." : "Viewing as customer.");
  } else if (target.id === "portal-account") {
    resetDraft();
    dispatch({ type: "select_account", accountId: target.value }, `Ordering as ${findAccount(state, target.value)?.name || "sample account"}.`);
  }
});

root.addEventListener("input", (event) => {
  const sku = event.target.getAttribute("data-sku");
  if (!sku) return;
  if (event.target.value.trim()) draft[sku] = event.target.value;
  else delete draft[sku];
  // Any edit starts a new submission; an unchanged draft keeps its id.
  if (lastSubmitted) {
    lastSubmitted = null;
    submissionId = newSubmissionId();
  }
  refreshValidation();
});

root.addEventListener("submit", (event) => {
  if (event.target.id !== "portal-order-form") return;
  event.preventDefault();
  // Re-submitting right after a success replays the same submission id, which the
  // workflow recognises as a duplicate instead of creating a second order.
  const replay = lastSubmitted && !Object.keys(draft).length;
  let lines = replay ? lastSubmitted.lines : [];
  if (!replay) {
    showErrors = true;
    const checked = refreshValidation();
    if (!checked.valid) {
      const firstInvalid = Object.keys(checked.errors)[0];
      announce(checked.formError || `Check the quantities: ${Object.values(checked.errors).join(" ")}`);
      (firstInvalid ? root.querySelector(`input[data-sku="${CSS.escape(firstInvalid)}"]`) : root.querySelector('input[data-sku]'))?.focus();
      return;
    }
    lines = checked.lines;
  }
  const result = dispatch({ type: "submit", accountId: state.accountId, lines, submissionId }, (ok) => {
    const order = ok.state.orders.find((item) => item.id === ok.orderId);
    if (ok.duplicateOf === "identical") return `${order.id} already contains exactly these lines. No duplicate order was created; change a quantity to place a different order.`;
    if (ok.duplicate) return `${order.id} was already submitted. No duplicate order was created.`;
    return order.status === STATUS.approved
      ? `${order.id} passed all rules and was auto-approved.`
      : `${order.id} paused for approval: ${order.exceptions.join(", ")}. Switch to the approver role to decide.`;
  }, true);
  if (result && !result.duplicate) {
    draft = {};
    showErrors = false;
    lastSubmitted = { lines };
    render();
  }
});

root.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.getAttribute("data-action");
  const orderId = button.getAttribute("data-order");
  if (action === "reset") {
    resetDraft();
    dispatch({ type: "reset" }, "Demo reset. Synthetic sample data restored.", true);
  } else if (action === "cancel") {
    dispatch({ type: "cancel", orderId }, `${orderId} cancelled.`, true);
  } else if (action === "approve" || action === "reject") {
    const reason = root.querySelector(`[data-reason="${CSS.escape(orderId)}"]`)?.value || "";
    dispatch({ type: action, orderId, reason }, `${orderId} ${action === "approve" ? "approved" : "rejected"}. Timeline and audit log updated.`, true);
  }
});

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  state = parseState(event.newValue || "");
  render();
});

root.classList.add("is-ready");
render();
