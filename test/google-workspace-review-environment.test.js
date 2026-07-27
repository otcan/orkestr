import assert from "node:assert/strict";
import test from "node:test";
import {
  createGoogleWorkspaceReviewEnvironmentLink,
  createGoogleWorkspaceReviewEnvironmentTicket,
  googleWorkspaceReviewEnvironmentTtlMs,
  verifyGoogleWorkspaceReviewEnvironmentTicket,
} from "../packages/connectors/src/google-workspace-review-environment.js";

function reviewEnv() {
  return {
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED: "1",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET: "review-access-secret-for-isolated-google-verification",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ENV_TTL_MINUTES: "30",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL: "https://review.example.test",
  };
}

test("reviewer environment ticket is signed and bound to one user and thread", () => {
  const env = reviewEnv();
  const ticket = createGoogleWorkspaceReviewEnvironmentTicket({ userId: "reviewer", threadId: "review-thread" }, env);

  assert.equal(verifyGoogleWorkspaceReviewEnvironmentTicket(ticket, { userId: "reviewer", threadId: "review-thread" }, env).ok, true);
  assert.equal(verifyGoogleWorkspaceReviewEnvironmentTicket(ticket, { userId: "another", threadId: "review-thread" }, env).ok, false);
  assert.equal(verifyGoogleWorkspaceReviewEnvironmentTicket(ticket, { userId: "reviewer", threadId: "another-thread" }, env).ok, false);
  assert.equal(verifyGoogleWorkspaceReviewEnvironmentTicket(`${ticket}x`, { userId: "reviewer", threadId: "review-thread" }, env).ok, false);
  assert.equal(googleWorkspaceReviewEnvironmentTtlMs(env), 30 * 60_000);
  assert.throws(
    () => createGoogleWorkspaceReviewEnvironmentTicket({ userId: "reviewer", threadId: "review-thread", expiresAt: "not-a-date" }, env),
    (error) => error.code === "google_workspace_review_environment_invalid_request",
  );
});

test("reviewer environment link uses the dedicated public host and needs reviewer configuration", () => {
  const link = createGoogleWorkspaceReviewEnvironmentLink({ userId: "reviewer", threadId: "review-thread" }, reviewEnv());
  assert.match(link.link, /^https:\/\/review\.example\.test\/review\/google\/[^/]+$/);
  assert.ok(Date.parse(link.expiresAt) > Date.now());
  assert.throws(
    () => createGoogleWorkspaceReviewEnvironmentLink({ userId: "reviewer", threadId: "review-thread" }, {}),
    (error) => error.code === "google_workspace_review_access_not_configured",
  );
});
