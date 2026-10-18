import { AssertionError } from "node:assert";

// Test reporting only: these are NOT product task states or an event envelope.
export function acceptanceCheck(condition, caseId, message) {
  if (condition) return;
  const error = new AssertionError({ actual: false, expected: true, operator: "acceptance", message });
  error.acceptanceCaseId = caseId;
  throw error;
}

export async function expectKnownGap(t, { id, ops, reason }, probe) {
  try {
    await probe();
  } catch (error) {
    // Setup failures, unrelated assertions and changed failure modes stay red.
    if (!(error instanceof AssertionError) || error.acceptanceCaseId !== id) throw error;
    if (process.env.ORKESTR_PERSONAL_AGENT_ACCEPTANCE_STRICT === "1") throw error;
    // Only the child assertion is TODO. The parent's setup/cleanup and any
    // later assertions remain blocking, including failed network guards.
    await t.test(`KNOWN_GAP ${id} ${ops.join(",")} — ${reason}`, { todo: reason }, () => { throw error; });
    return;
  }
  throw new Error(`UNEXPECTED_PASS ${id}: review the evidence and promote this case to a regression test`);
}
