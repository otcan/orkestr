import assert from "node:assert/strict";
import test from "node:test";
import {
  createGoogleWorkspaceReviewEnvironmentLink,
  createGoogleWorkspaceReviewEnvironmentTicket,
  googleWorkspaceReviewEnvironmentWorkspacePath,
  googleWorkspaceReviewEnvironmentTtlMs,
  verifyGoogleWorkspaceReviewPassword,
  verifyGoogleWorkspaceReviewEnvironmentTicket,
} from "../packages/connectors/src/google-workspace-review-environment.js";

function reviewEnv() {
  return {
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED: "1",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET: "review-access-secret-for-isolated-google-verification",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ENV_TTL_MINUTES: "30",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL: "https://review.example.test",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD: "a-long-review-password-for-isolated-oauth",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_USER_ID: "reviewer",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_THREAD_ID: "review-thread",
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

test("reviewer environment link is stable and requires the configured review thread", () => {
  const env = reviewEnv();
  const link = createGoogleWorkspaceReviewEnvironmentLink({ userId: "reviewer", threadId: "review-thread" }, env);
  assert.equal(link.link, "https://review.example.test/review/google");
  assert.equal(googleWorkspaceReviewEnvironmentWorkspacePath(env), "/thread/review-thread");
  assert.throws(
    () => createGoogleWorkspaceReviewEnvironmentLink({ userId: "reviewer", threadId: "another-thread" }, reviewEnv()),
    (error) => error.code === "google_workspace_review_environment_identity_mismatch",
  );
  assert.throws(
    () => createGoogleWorkspaceReviewEnvironmentLink({ userId: "reviewer", threadId: "review-thread" }, {}),
    (error) => error.code === "google_workspace_review_password_not_configured",
  );
});

test("review password is verified only when the isolated environment is enabled", () => {
  const env = reviewEnv();
  assert.equal(verifyGoogleWorkspaceReviewPassword("a-long-review-password-for-isolated-oauth", env), true);
  assert.equal(verifyGoogleWorkspaceReviewPassword("wrong", env), false);
  assert.equal(verifyGoogleWorkspaceReviewPassword("a-long-review-password-for-isolated-oauth", {}), false);
});
