import assert from "node:assert/strict";
import test from "node:test";
import {
  LARGE_ORDER_THRESHOLD,
  ROLES,
  STATUS,
  createInitialState,
  evaluateRules,
  findAccount,
  findProduct,
  normalizeLines,
  parseState,
  pendingOrders,
  serializeState,
  transition,
  validateDraft,
} from "../apps/server/public-builds/customer-portal/workflow.js";

let tick = 0;
const context = { now: () => Date.UTC(2026, 0, 1, 9, 0, tick++) };

let submission = 0;
const nextSubmission = () => `test-submission-${++submission}`;

function run(state, action) {
  const withId = action.type === "submit" && !action.submissionId ? { ...action, submissionId: nextSubmission() } : action;
  const result = transition(state, withId, context);
  assert.equal(result.ok, true, result.error);
  return result;
}

test("initial state is synthetic sample data with a reset audit entry", () => {
  const state = createInitialState(context);
  assert.equal(state.role, ROLES.customer);
  assert.equal(state.orders.length, 0);
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].action, "demo_reset");
  assert.ok(state.accounts.every((account) => /\(sample\)$/.test(account.name)));
});

test("an order that passes every rule is auto-approved and reserves stock", () => {
  const initial = createInitialState(context);
  const { state, orderId } = run(initial, { type: "submit", role: ROLES.customer, lines: [{ sku: "VLV-100", quantity: 10 }] });
  const order = state.orders.find((item) => item.id === orderId);
  assert.equal(order.status, STATUS.approved);
  assert.equal(order.decision.by, "rules");
  assert.deepEqual(order.exceptions, []);
  assert.equal(findProduct(state, "VLV-100").stock, 110);
  assert.equal(findAccount(state, "ACC-NORTH").openBalance, 3500 + 420);
  assert.deepEqual(order.timeline.map((entry) => entry.event), ["Submitted", "Rules checked", "Auto-approved"]);
  assert.deepEqual(state.audit.slice(1).map((entry) => entry.action), ["order_submitted", "order_auto_approved"]);
  assert.equal(findProduct(initial, "VLV-100").stock, 120, "transition must not mutate its input");
});

test("stock, credit and order value exceptions pause the order for an approver", () => {
  const initial = createInitialState(context);
  const stock = run(initial, { type: "submit", role: ROLES.customer, lines: [{ sku: "FLT-405", quantity: 1 }] });
  assert.deepEqual(stock.state.orders[0].exceptions, ["stock"]);
  assert.equal(stock.state.orders[0].status, STATUS.pendingApproval);

  const harbor = run(initial, { type: "select_account", accountId: "ACC-HARBOR" }).state;
  const credit = run(harbor, { type: "submit", role: ROLES.customer, lines: [{ sku: "SNS-310", quantity: 10 }] });
  assert.deepEqual(credit.state.orders[0].exceptions, ["credit"]);
  assert.equal(credit.state.orders[0].accountId, "ACC-HARBOR");

  const big = evaluateRules(initial, "ACC-NORTH", [{ sku: "PMP-220", quantity: 8 }]);
  assert.ok(big.total > LARGE_ORDER_THRESHOLD);
  assert.deepEqual(big.exceptions, ["order_value"]);
  assert.equal(pendingOrders(credit.state).length, 1);
});

test("approver approves an exception, reserving available stock and backordering the rest", () => {
  let state = run(createInitialState(context), { type: "submit", role: ROLES.customer, lines: [{ sku: "PMP-220", quantity: 10 }] }).state;
  const orderId = state.orders[0].id;
  assert.ok(state.orders[0].exceptions.includes("stock"));
  state = run(state, { type: "switch_role", role: ROLES.approver }).state;
  state = run(state, { type: "approve", role: ROLES.approver, orderId, reason: "Customer accepts partial delivery." }).state;
  const order = state.orders[0];
  assert.equal(order.status, STATUS.approved);
  assert.deepEqual(order.decision, { by: ROLES.approver, outcome: "approved", reason: "Customer accepts partial delivery." });
  assert.equal(order.lines[0].reserved, 8);
  assert.equal(order.lines[0].backordered, 2);
  assert.equal(findProduct(state, "PMP-220").stock, 0);
  assert.equal(order.timeline.at(-1).event, "Approved");
  assert.equal(state.audit.at(-1).action, "order_approved");
  assert.deepEqual(state.audit.map((entry) => entry.seq), state.audit.map((_, index) => index + 1));
});

test("rejection requires a reason and leaves stock and credit untouched", () => {
  let state = run(createInitialState(context), { type: "submit", role: ROLES.customer, lines: [{ sku: "FLT-405", quantity: 3 }] }).state;
  const orderId = state.orders[0].id;
  const missing = transition(state, { type: "reject", role: ROLES.approver, orderId, reason: "  " }, context);
  assert.deepEqual(missing, { ok: false, error: "A reason is required to reject an order." });
  state = run(state, { type: "reject", role: ROLES.approver, orderId, reason: "No stock this quarter." }).state;
  assert.equal(state.orders[0].status, STATUS.rejected);
  assert.equal(findAccount(state, "ACC-NORTH").openBalance, 3500);
  assert.equal(state.audit.at(-1).action, "order_rejected");
});

test("roles are enforced and decided orders cannot change again", () => {
  let state = createInitialState(context);
  assert.equal(transition(state, { type: "submit", role: ROLES.approver, lines: [{ sku: "VLV-100", quantity: 1 }] }).ok, false);
  state = run(state, { type: "submit", role: ROLES.customer, lines: [{ sku: "FLT-405", quantity: 1 }] }).state;
  const orderId = state.orders[0].id;
  assert.equal(transition(state, { type: "approve", role: ROLES.customer, orderId }).ok, false);
  state = run(state, { type: "cancel", role: ROLES.customer, orderId }).state;
  assert.equal(state.orders[0].status, STATUS.cancelled);
  assert.match(transition(state, { type: "approve", role: ROLES.approver, orderId }).error, /not waiting for approval/);
  assert.match(transition(state, { type: "cancel", role: ROLES.customer, orderId }).error, /can no longer be cancelled/);
  assert.equal(transition(state, { type: "approve", role: ROLES.approver, orderId: "PO-9999" }).error, "Order not found.");
  assert.equal(transition(state, { type: "switch_role", role: "admin" }).ok, false);
  assert.equal(transition(state, { type: "explode" }).ok, false);
});

test("submissions validate quantities and products", () => {
  const state = createInitialState(context);
  assert.deepEqual(normalizeLines([{ sku: "VLV-100", quantity: "2" }, { sku: "VLV-100", quantity: 3 }, { sku: "SNS-310", quantity: -1 }, { sku: "", quantity: 4 }, { sku: "PMP-220", quantity: 5000 }]), [{ sku: "VLV-100", quantity: 5 }, { sku: "PMP-220", quantity: 999 }]);
  assert.equal(transition(state, { type: "submit", role: ROLES.customer, submissionId: nextSubmission(), lines: [] }).error, "Add at least one product quantity.");
  assert.equal(transition(state, { type: "submit", role: ROLES.customer, submissionId: nextSubmission(), lines: [{ sku: "NOPE-1", quantity: 1 }] }).error, "Unknown product NOPE-1.");
});

test("reset restores sample data and state round-trips through storage", () => {
  let state = run(createInitialState(context), { type: "submit", role: ROLES.customer, lines: [{ sku: "FLT-405", quantity: 1 }] }).state;
  const restored = parseState(serializeState(state), context);
  assert.deepEqual(restored, state);
  state = run(state, { type: "reset" }).state;
  assert.equal(state.orders.length, 0);
  assert.equal(findProduct(state, "FLT-405").stock, 0);
  assert.equal(state.nextOrderNumber, 1001);
  for (const raw of ["", "not json", "{}", JSON.stringify({ ...state, version: 99 }), JSON.stringify({ ...state, orders: [{ id: 1 }] })]) {
    const fallback = parseState(raw, context);
    assert.equal(fallback.orders.length, 0);
    assert.equal(fallback.audit[0].action, "demo_reset");
  }
});

test("draft validation reports every invalid quantity with a message", () => {
  const state = createInitialState(context);
  const result = validateDraft(state, { "VLV-100": "2.5", "SNS-310": "-3", "PMP-220": "abc", "FLT-405": "1000", "NOPE-1": "1" });
  assert.equal(result.valid, false);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.errors, {
    "VLV-100": "Enter a whole number of units.",
    "SNS-310": "Quantity cannot be negative.",
    "PMP-220": "Enter a whole number of units.",
    "FLT-405": "At most 999 units per line.",
    "NOPE-1": "Unknown product NOPE-1.",
  });
  assert.equal(validateDraft(state, {}).formError, "Add at least one product quantity.");
  assert.equal(validateDraft(state, { "VLV-100": "0", "SNS-310": "  " }).formError, "Add at least one product quantity.");
  assert.deepEqual(validateDraft(state, { "VLV-100": " 4 ", "SNS-310": "0" }), { lines: [{ sku: "VLV-100", quantity: 4 }], errors: {}, formError: "", valid: true });
});

test("the state machine refuses invalid quantities and missing submission ids", () => {
  const state = createInitialState(context);
  const base = { type: "submit", role: ROLES.customer };
  assert.equal(transition(state, { ...base, lines: [{ sku: "VLV-100", quantity: 1 }] }).error, "Missing submission id.");
  for (const quantity of [2.5, -1, 1000, "abc"]) {
    const result = transition(state, { ...base, submissionId: nextSubmission(), lines: [{ sku: "VLV-100", quantity }] });
    assert.equal(result.ok, false, String(quantity));
    assert.match(result.error, /Invalid quantity for VLV-100/);
  }
});

test("repeating a submission is idempotent and never creates a second order", () => {
  const initial = createInitialState(context);
  const action = { type: "submit", role: ROLES.customer, submissionId: "double-click-0001", lines: [{ sku: "VLV-100", quantity: 10 }] };
  const first = run(initial, action);
  assert.equal(first.duplicate, false);
  const again = run(first.state, action);
  assert.equal(again.duplicate, true);
  assert.equal(again.orderId, first.orderId);
  assert.equal(again.state.orders.length, 1);
  assert.equal(findProduct(again.state, "VLV-100").stock, 110, "stock is reserved only once");
  assert.equal(again.state.audit.length, first.state.audit.length, "no extra audit entries");
  const replayedAfterReload = run(parseState(serializeState(first.state), context), action);
  assert.equal(replayedAfterReload.duplicate, true);
  const fresh = run(first.state, { ...action, submissionId: "second-order-0002" });
  assert.equal(fresh.state.orders.length, 2, "a new submission id is a new order");
  assert.equal(run(fresh.state, { type: "reset" }).state.submissions && Object.keys(run(fresh.state, { type: "reset" }).state.submissions).length, 0);
});

test("saved state from before submission tracking still loads", () => {
  const legacy = createInitialState(context);
  delete legacy.submissions;
  assert.deepEqual(parseState(JSON.stringify(legacy), context).submissions, {});
});
