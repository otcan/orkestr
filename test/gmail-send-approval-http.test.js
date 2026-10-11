import assert from "node:assert/strict";
import test from "node:test";
import { requestGmailSendApproval } from "../packages/connectors/src/gmail-send-approvals.js";
import { jsonPost, pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

test("Gmail send approvals require the account owner session and same-site decision", async () => {
  const fixture = await startFixtureServer();
  try {
    const principal = { userId: "admin" };
    const request = await requestGmailSendApproval({
      connectionId: "fake-connection",
      threadId: "fake-thread",
      details: { to: "friend@example.test", subject: "Hello", body: "Review me" },
    }, principal, process.env);
    const cookie = await pairedCookie();
    const pathname = `/api/connectors/gmail/send-approvals/${request.requestId}/decision`;
    const anonymous = await rawRequest(fixture.port, { pathname: "/api/connectors/gmail/send-approvals" });
    assert.equal(anonymous.status, 401);
    const listed = await rawRequest(fixture.port, { pathname: "/api/connectors/gmail/send-approvals", headers: { cookie } });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.requests[0].details.body, "Review me");

    const anonymousDecision = await jsonPost(fixture.port, pathname, { approve: true });
    assert.equal(anonymousDecision.status, 401);
    const crossSite = await jsonPost(fixture.port, pathname, { approve: true }, { cookie, origin: "https://other.example.test" });
    assert.equal(crossSite.status, 403);
    const nonBoolean = await jsonPost(fixture.port, pathname, { approve: "true" }, { cookie });
    assert.equal(nonBoolean.status, 400);
    const approved = await jsonPost(fixture.port, pathname, { approve: true }, { cookie });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.json.approved, true);
  } finally {
    await fixture.close();
  }
});
