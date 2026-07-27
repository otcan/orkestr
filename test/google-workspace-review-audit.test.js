import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendGoogleWorkspaceReviewAudit, listGoogleWorkspaceReviewAudit } from "../packages/connectors/src/google-workspace-review-audit.js";
import { userPrincipal } from "../packages/core/src/principal.js";

test("review audit records only fixed redacted action names in the review user scope", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-review-audit-"));
  const env = { ORKESTR_HOME: home };
  const principal = userPrincipal({ id: "reviewer" });

  await appendGoogleWorkspaceReviewAudit("gmail_message_sent", env, { principal });
  await appendGoogleWorkspaceReviewAudit("not-an-action", env, { principal });
  const events = await listGoogleWorkspaceReviewAudit(env, { principal });

  assert.equal(events.length, 1);
  assert.equal(events[0].action, "gmail_message_sent");
  assert.equal(events[0].state, "completed");
  assert.deepEqual(Object.keys(events[0]).sort(), ["action", "at", "state"]);
});
