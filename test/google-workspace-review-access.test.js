import assert from "node:assert/strict";
import test from "node:test";
import {
  createGoogleWorkspaceReviewAccessTicket,
  googleWorkspaceReviewAccessTtlMs,
  verifyGoogleWorkspaceReviewAccessTicket,
} from "../packages/connectors/src/google-workspace-review-access.js";

function reviewEnv() {
  return {
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED: "1",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET: "review-access-secret-for-isolated-google-verification",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_TTL_MINUTES: "30",
  };
}

test("review access ticket is bound to one connection, user, and expiry", () => {
  const env = reviewEnv();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const ticket = createGoogleWorkspaceReviewAccessTicket({
    connectId: "connect-1",
    userId: "reviewer",
    expiresAt,
  }, env);

  assert.equal(verifyGoogleWorkspaceReviewAccessTicket(ticket, { connectId: "connect-1", userId: "reviewer" }, env).ok, true);
  assert.equal(verifyGoogleWorkspaceReviewAccessTicket(ticket, { connectId: "connect-2", userId: "reviewer" }, env).ok, false);
  assert.equal(verifyGoogleWorkspaceReviewAccessTicket(ticket, { connectId: "connect-1", userId: "another-user" }, env).ok, false);
  assert.equal(verifyGoogleWorkspaceReviewAccessTicket(`${ticket}x`, { connectId: "connect-1", userId: "reviewer" }, env).ok, false);
  assert.equal(
    verifyGoogleWorkspaceReviewAccessTicket(ticket, { connectId: "connect-1", userId: "reviewer" }, {
      ...env,
      ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED: "0",
    }).ok,
    false,
  );
});

test("review access refuses missing configuration and expired requests", () => {
  assert.throws(
    () => createGoogleWorkspaceReviewAccessTicket({
      connectId: "connect-1",
      userId: "reviewer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, {}),
    (error) => error.code === "google_workspace_review_access_not_configured",
  );
  assert.throws(
    () => createGoogleWorkspaceReviewAccessTicket({
      connectId: "connect-1",
      userId: "reviewer",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }, reviewEnv()),
    (error) => error.code === "google_workspace_review_access_invalid_request",
  );
  assert.equal(googleWorkspaceReviewAccessTtlMs(reviewEnv()), 30 * 60_000);
});
