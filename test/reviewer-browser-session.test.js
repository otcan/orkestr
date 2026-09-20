import assert from "node:assert/strict";
import test from "node:test";
import { reviewerBrowserSessionActive, reviewerBrowserSessionFields } from "../packages/core/src/reviewer-browser-session.js";

const env = {
  ORKESTR_HOME: "/fixture/review-instance",
  ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED: "1",
  ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET: "synthetic-signing-secret-32-characters",
  ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD: "synthetic-review-password",
  ORKESTR_GOOGLE_WORKSPACE_REVIEW_USER_ID: "reviewer",
  ORKESTR_GOOGLE_WORKSPACE_REVIEW_THREAD_ID: "review-thread",
  ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL: "https://review.example.test",
  ORKESTR_GOOGLE_WORKSPACE_REVIEW_ENV_TTL_MINUTES: "30",
};

test("reviewer sessions have a bounded lifetime without persisting signing or password material", () => {
  const before = Date.now(), fields = reviewerBrowserSessionFields("reviewer", env);
  assert.ok(Date.parse(fields.expiresAt) >= before + 30 * 60_000);
  assert.ok(Date.parse(fields.expiresAt) <= Date.now() + 30 * 60_000);
  assert.equal(JSON.stringify(fields).includes(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET), false);
  assert.equal(JSON.stringify(fields).includes(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD), false);
  assert.equal(reviewerBrowserSessionActive({ ...fields, userId: "reviewer" }, env), true);
  assert.throws(() => reviewerBrowserSessionFields("other-owner", env), /not_configured/);
});

test("rotation, disabling and changing reviewer identity/instance invalidate only reviewer sessions", () => {
  const session = { userId: "reviewer", ...reviewerBrowserSessionFields("reviewer", env) };
  for (const [key, value] of Object.entries({
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED: "0",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET: "replacement-signing-secret-32-characters",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD: "replacement-review-password",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_USER_ID: "other-reviewer",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_THREAD_ID: "other-thread",
    ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL: "https://other.example.test",
    ORKESTR_HOME: "/fixture/other-instance",
  })) {
    assert.equal(reviewerBrowserSessionActive(session, { ...env, [key]: value }), false, key);
    assert.equal(reviewerBrowserSessionActive({ userId: "ordinary-operator" }, { ...env, [key]: value }), true);
  }
  assert.equal(reviewerBrowserSessionActive({ userId: "reviewer" }, env), false, "legacy 90-day reviewer sessions need a fresh sign-in");
});
