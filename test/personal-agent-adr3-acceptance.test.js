import assert from "node:assert/strict";
import test from "node:test";
import { adr3Cases } from "./fixtures/personal-agent-acceptance/adr3-cases.mjs";

// Pending integration, not an executed product failure. No fake session service
// or inferred API is allowed to turn these cases green. Promote one at a time
// after independent review against the owning lane's actual entry points.
for (const { id, title, ops, gap } of adr3Cases) {
  const name = `ADR3 ${id} [${ops.join(" ")}]: ${title}`;
  if (process.env.ORKESTR_PERSONAL_AGENT_ACCEPTANCE_STRICT === "1") {
    test(name, () => assert.fail(`PENDING_ACCEPTANCE ${id}: ${gap}`));
  } else {
    test(name, { todo: `PENDING_INTEGRATION: ${gap}` }, () => {
      assert.fail(`PENDING_ACCEPTANCE ${id}: ${gap}`);
    });
  }
}
