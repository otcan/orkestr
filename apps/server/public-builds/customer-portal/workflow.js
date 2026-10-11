// Synthetic B2B customer portal workflow. Pure functions only: no DOM, no network,
// no storage access. Shared by the browser demo and the unit tests.

export const STORAGE_KEY = "orkestr-demo-customer-portal-v1";
export const STATE_VERSION = 1;
export const LARGE_ORDER_THRESHOLD = 5000;
export const MAX_LINE_QUANTITY = 999;
export const MAX_REASON_LENGTH = 200;
export const MAX_REMEMBERED_SUBMISSIONS = 50;

export const ROLES = Object.freeze({ customer: "customer", approver: "approver" });

export const STATUS = Object.freeze({
  pendingApproval: "pending_approval",
  approved: "approved",
  rejected: "rejected",
  cancelled: "cancelled",
});

export const STATUS_LABELS = Object.freeze({
  pending_approval: "Waiting for approver",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
});

const SAMPLE_PRODUCTS = [
  { sku: "VLV-100", name: "Brass ball valve DN25", unitPrice: 42, stock: 120 },
  { sku: "PMP-220", name: "Inline circulation pump", unitPrice: 690, stock: 8 },
  { sku: "SNS-310", name: "Pressure sensor 0-10 bar", unitPrice: 115, stock: 40 },
  { sku: "FLT-405", name: "Cartridge filter housing", unitPrice: 230, stock: 0 },
];

const SAMPLE_ACCOUNTS = [
  { id: "ACC-NORTH", name: "Northwind Facilities (sample)", creditLimit: 12000, openBalance: 3500 },
  { id: "ACC-HARBOR", name: "Harbor Labs (sample)", creditLimit: 4000, openBalance: 3100 },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stamp(context = {}) {
  const value = typeof context.now === "function" ? context.now() : new Date();
  return new Date(value).toISOString();
}

export function createInitialState(context = {}) {
  const at = stamp(context);
  return {
    version: STATE_VERSION,
    role: ROLES.customer,
    accountId: SAMPLE_ACCOUNTS[0].id,
    products: clone(SAMPLE_PRODUCTS),
    accounts: clone(SAMPLE_ACCOUNTS),
    orders: [],
    submissions: {},
    audit: [{ seq: 1, at, role: "system", action: "demo_reset", orderId: "", detail: "Synthetic sample data loaded." }],
    nextOrderNumber: 1001,
    nextAuditSeq: 2,
  };
}

export function findProduct(state, sku) {
  return state.products.find((product) => product.sku === sku) || null;
}

export function findAccount(state, accountId) {
  return state.accounts.find((account) => account.id === accountId) || null;
}

export function findOrder(state, orderId) {
  return state.orders.find((order) => order.id === orderId) || null;
}

export function normalizeLines(lines = []) {
  const merged = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const sku = String(line?.sku || "").trim();
    const quantity = Math.floor(Number(line?.quantity));
    if (!sku || !Number.isFinite(quantity) || quantity <= 0) continue;
    merged.set(sku, Math.min(MAX_LINE_QUANTITY, (merged.get(sku) || 0) + quantity));
  }
  return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
}

// Validate raw form input ({ sku: "text" }) without guessing: anything that is not
// a whole number between 0 and MAX_LINE_QUANTITY is reported back to the buyer.
export function validateDraft(state, raw = {}) {
  const lines = [];
  const errors = {};
  for (const [sku, value] of Object.entries(raw || {})) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    if (!findProduct(state, sku)) errors[sku] = `Unknown product ${sku}.`;
    else if (!/^-?\d+$/.test(text)) errors[sku] = "Enter a whole number of units.";
    else if (Number(text) < 0) errors[sku] = "Quantity cannot be negative.";
    else if (Number(text) > MAX_LINE_QUANTITY) errors[sku] = `At most ${MAX_LINE_QUANTITY} units per line.`;
    else if (Number(text) > 0) lines.push({ sku, quantity: Number(text) });
  }
  const formError = !Object.keys(errors).length && !lines.length ? "Add at least one product quantity." : "";
  return { lines, errors, formError, valid: !formError && !Object.keys(errors).length };
}

export function orderTotal(state, lines) {
  return lines.reduce((sum, line) => sum + (findProduct(state, line.sku)?.unitPrice || 0) * line.quantity, 0);
}

// Run the business rules against current stock and credit. Every rule reports a
// result; any failing rule turns the order into an exception for the approver.
export function evaluateRules(state, accountId, lines) {
  const account = findAccount(state, accountId);
  const total = orderTotal(state, lines);
  const shortages = lines
    .map((line) => ({ line, product: findProduct(state, line.sku) }))
    .filter(({ line, product }) => !product || product.stock < line.quantity)
    .map(({ line, product }) => `${line.sku}: ordered ${line.quantity}, available ${product ? product.stock : 0}`);
  const exposure = (account?.openBalance || 0) + total;
  const checks = [
    {
      rule: "stock",
      label: "Stock available",
      passed: shortages.length === 0,
      detail: shortages.length ? `Short: ${shortages.join("; ")}` : "All lines can be reserved from stock.",
    },
    {
      rule: "credit",
      label: "Within credit limit",
      passed: Boolean(account) && exposure <= account.creditLimit,
      detail: account
        ? `Open balance ${account.openBalance} + order ${total} = ${exposure} of limit ${account.creditLimit}.`
        : "Unknown account.",
    },
    {
      rule: "order_value",
      label: `Order value up to ${LARGE_ORDER_THRESHOLD}`,
      passed: total <= LARGE_ORDER_THRESHOLD,
      detail: total <= LARGE_ORDER_THRESHOLD ? `Order value ${total}.` : `Order value ${total} needs a second look.`,
    },
  ];
  return { total, checks, exceptions: checks.filter((check) => !check.passed).map((check) => check.rule) };
}

function fail(message) {
  return { ok: false, error: message };
}

function appendAudit(state, entry, context) {
  state.audit.push({ seq: state.nextAuditSeq, at: stamp(context), ...entry });
  state.nextAuditSeq += 1;
}

function addTimeline(order, entry, context) {
  order.timeline.push({ at: stamp(context), ...entry });
}

// Reserve stock and book the order value against the account once approved.
function applyApproval(state, order) {
  for (const line of order.lines) {
    const product = findProduct(state, line.sku);
    if (!product) continue;
    const reserved = Math.min(product.stock, line.quantity);
    product.stock -= reserved;
    line.reserved = reserved;
    line.backordered = line.quantity - reserved;
  }
  const account = findAccount(state, order.accountId);
  if (account) account.openBalance += order.total;
}

function lineKey(lines) {
  return lines.map((line) => `${line.sku}:${line.quantity}`).sort().join("|");
}

export function findRepeatOrder(state, accountId, lines) {
  const latest = state.orders.find((order) => order.accountId === accountId);
  if (!latest || ![STATUS.pendingApproval, STATUS.approved].includes(latest.status)) return null;
  return lineKey(latest.lines) === lineKey(normalizeLines(lines)) ? latest : null;
}

function submitOrder(state, action, context) {
  if (action.role !== ROLES.customer) return fail("Only the customer role can submit orders.");
  const submissionId = String(action.submissionId || "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(submissionId)) return fail("Missing submission id.");
  // Idempotency: replaying the same submission returns the order it already created.
  const existing = state.submissions[submissionId];
  if (existing && findOrder(state, existing)) return { ok: true, state, orderId: existing, duplicate: true, duplicateOf: "submission" };
  const account = findAccount(state, action.accountId || state.accountId);
  if (!account) return fail("Choose a sample account.");
  const invalid = (Array.isArray(action.lines) ? action.lines : []).find((line) => !Number.isInteger(Number(line?.quantity)) || Number(line?.quantity) < 0 || Number(line?.quantity) > MAX_LINE_QUANTITY);
  if (invalid) return fail(`Invalid quantity for ${String(invalid?.sku || "a line")}.`);
  const lines = normalizeLines(action.lines);
  if (!lines.length) return fail("Add at least one product quantity.");
  const unknown = lines.find((line) => !findProduct(state, line.sku));
  if (unknown) return fail(`Unknown product ${unknown.sku}.`);
  // The same request typed in again (same account, same lines) as the account's
  // latest open or approved order is treated as a repeat, not a new order.
  const repeat = findRepeatOrder(state, account.id, lines);
  if (repeat) return { ok: true, state, orderId: repeat.id, duplicate: true, duplicateOf: "identical" };
  const { total, checks, exceptions } = evaluateRules(state, account.id, lines);
  const order = {
    id: `PO-${state.nextOrderNumber}`,
    accountId: account.id,
    lines,
    total,
    checks,
    exceptions,
    status: STATUS.pendingApproval,
    decision: null,
    timeline: [],
  };
  state.nextOrderNumber += 1;
  addTimeline(order, { actor: ROLES.customer, event: "Submitted", detail: `${lines.length} line(s), total ${total}.` }, context);
  addTimeline(order, { actor: "rules", event: "Rules checked", detail: checks.map((check) => `${check.label}: ${check.passed ? "pass" : "fail"}`).join(" · ") }, context);
  appendAudit(state, { role: ROLES.customer, action: "order_submitted", orderId: order.id, detail: `${account.name}, total ${total}.` }, context);
  if (exceptions.length) {
    addTimeline(order, { actor: "rules", event: "Paused for approval", detail: `Exception: ${exceptions.join(", ")}.` }, context);
    appendAudit(state, { role: "rules", action: "order_paused", orderId: order.id, detail: `Exceptions: ${exceptions.join(", ")}.` }, context);
  } else {
    order.status = STATUS.approved;
    order.decision = { by: "rules", outcome: "approved", reason: "All rules passed." };
    applyApproval(state, order);
    addTimeline(order, { actor: "rules", event: "Auto-approved", detail: "All rules passed; stock reserved." }, context);
    appendAudit(state, { role: "rules", action: "order_auto_approved", orderId: order.id, detail: "All rules passed." }, context);
  }
  state.orders.unshift(order);
  state.submissions[submissionId] = order.id;
  const remembered = Object.keys(state.submissions);
  for (const key of remembered.slice(0, Math.max(0, remembered.length - MAX_REMEMBERED_SUBMISSIONS))) delete state.submissions[key];
  return { ok: true, state, orderId: order.id, duplicate: false };
}

function decideOrder(state, action, context) {
  if (action.role !== ROLES.approver) return fail("Only the approver role can approve or reject.");
  const order = findOrder(state, action.orderId);
  if (!order) return fail("Order not found.");
  if (order.status !== STATUS.pendingApproval) return fail(`Order ${order.id} is not waiting for approval.`);
  const reason = String(action.reason || "").trim().slice(0, MAX_REASON_LENGTH);
  const approve = action.type === "approve";
  if (!approve && !reason) return fail("A reason is required to reject an order.");
  order.status = approve ? STATUS.approved : STATUS.rejected;
  order.decision = { by: ROLES.approver, outcome: approve ? "approved" : "rejected", reason };
  if (approve) applyApproval(state, order);
  const backordered = order.lines.reduce((sum, line) => sum + (line.backordered || 0), 0);
  const detail = [reason, approve && backordered ? `${backordered} unit(s) backordered.` : ""].filter(Boolean).join(" ") || "No reason given.";
  addTimeline(order, { actor: ROLES.approver, event: approve ? "Approved" : "Rejected", detail }, context);
  appendAudit(state, { role: ROLES.approver, action: approve ? "order_approved" : "order_rejected", orderId: order.id, detail }, context);
  return { ok: true, state, orderId: order.id };
}

function cancelOrder(state, action, context) {
  if (action.role !== ROLES.customer) return fail("Only the customer role can cancel its own order.");
  const order = findOrder(state, action.orderId);
  if (!order) return fail("Order not found.");
  if (order.status !== STATUS.pendingApproval) return fail(`Order ${order.id} can no longer be cancelled.`);
  order.status = STATUS.cancelled;
  order.decision = { by: ROLES.customer, outcome: "cancelled", reason: "Withdrawn by customer." };
  addTimeline(order, { actor: ROLES.customer, event: "Cancelled", detail: "Withdrawn before a decision." }, context);
  appendAudit(state, { role: ROLES.customer, action: "order_cancelled", orderId: order.id, detail: "Withdrawn before a decision." }, context);
  return { ok: true, state, orderId: order.id };
}

// Single entry point. Never mutates the input state; returns { ok, state } or { ok:false, error }.
export function transition(current, action = {}, context = {}) {
  if (action.type === "reset") return { ok: true, state: createInitialState(context) };
  const state = clone(current);
  if (action.type === "switch_role") {
    if (!Object.values(ROLES).includes(action.role)) return fail("Unknown role.");
    state.role = action.role;
    return { ok: true, state };
  }
  if (action.type === "select_account") {
    if (!findAccount(state, action.accountId)) return fail("Unknown sample account.");
    state.accountId = action.accountId;
    return { ok: true, state };
  }
  if (action.type === "submit") return submitOrder(state, action, context);
  if (action.type === "approve" || action.type === "reject") return decideOrder(state, action, context);
  if (action.type === "cancel") return cancelOrder(state, action, context);
  return fail(`Unknown action ${String(action.type || "")}.`);
}

export function pendingOrders(state) {
  return state.orders.filter((order) => order.status === STATUS.pendingApproval);
}

export function serializeState(state) {
  return JSON.stringify(state);
}

// Accept only well-formed state written by this demo; anything else falls back
// to fresh sample data so a corrupted or tampered entry cannot break the page.
export function parseState(raw, context = {}) {
  try {
    const value = JSON.parse(String(raw || ""));
    if (value && value.submissions === undefined) value.submissions = {};
    const valid = value && value.version === STATE_VERSION
      && Object.values(ROLES).includes(value.role)
      && Array.isArray(value.products) && Array.isArray(value.accounts)
      && Array.isArray(value.orders) && Array.isArray(value.audit)
      && value.submissions && typeof value.submissions === "object" && !Array.isArray(value.submissions)
      && Number.isInteger(value.nextOrderNumber) && Number.isInteger(value.nextAuditSeq)
      && value.orders.every((order) => order && typeof order.id === "string" && Object.values(STATUS).includes(order.status) && Array.isArray(order.lines) && Array.isArray(order.timeline));
    if (valid) return value;
  } catch {
    // Fall through to fresh sample data.
  }
  return createInitialState(context);
}
