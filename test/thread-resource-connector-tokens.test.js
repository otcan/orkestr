import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeConnectorMcpToken, assertConnectorMcpScope } from "../packages/connectors/src/connectors-mcp-auth.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import {
  advanceThreadResourceGeneration,
  readThreadResourcePolicy,
  registerThreadResource,
  setThreadResourceGrants,
} from "../packages/core/src/thread-resource-grants.js";
import { assertConnectorMcpResourceAccess } from "../packages/core/src/thread-resource-sessions.js";
import { threadResourcePolicyDoctorReport } from "../packages/core/src/thread-resource-policy-doctor.js";

function tokenRecord({ token = "resource-token", resource, thread, policyRevision, grantRevision, resourceGeneration, overrides = {} } = {}) {
  const issuedAt = new Date().toISOString();
  return {
    token,
    scopes: ["connectors:read"],
    principalKind: "tenant_vm",
    principalId: "tenant-instance",
    ownerUserId: "tenant",
    instanceId: "tenant-instance",
    threadId: thread.id,
    rootThreadId: thread.id,
    resourceType: "oxrm",
    resourceId: resource.id,
    resourceActions: ["read"],
    boundaryId: resource.boundaryId,
    policyRevision,
    grantRevision,
    resourceGeneration,
    jti: "resource-execution-jti",
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + (4 * 60_000)).toISOString(),
    ...overrides,
  };
}

async function fixture({ grant = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-resource-connector-token-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_OXRM_ACCESS_MODE: "enforce",
    ORKESTR_DESKTOP_ACCESS_MODE: "off",
    ORKESTR_MAILBOX_ACCESS_MODE: "off",
  };
  const principal = adminPrincipal("admin");
  const thread = await createThread({ id: "resource-token-thread", name: "Resource token", ownerUserId: "tenant" }, env);
  const registered = await registerThreadResource({ resourceType: "oxrm", resourceId: "crm-primary", ownerUserId: "tenant", status: "active" }, { principal }, env);
  const granted = grant
    ? await setThreadResourceGrants(thread.id, "oxrm", [{ resourceId: "crm-primary", permissions: ["read", "execute"] }], { principal }, env)
    : null;
  const state = await readThreadResourcePolicy(env);
  const token = "private-bearer-secret";
  env.ORKESTR_CONNECTORS_MCP_TOKENS_JSON = JSON.stringify({
    resource: tokenRecord({
      token,
      resource: registered.resource,
      thread,
      policyRevision: state.revision,
      grantRevision: granted?.grants?.[0]?.revision || 1,
      resourceGeneration: registered.resource.generation,
    }),
  });
  const auth = await authorizeConnectorMcpToken(token, env);
  const input = {
    service: "whatsapp",
    action: "status",
    instance_id: "tenant-instance",
    user_id: "tenant",
    thread_id: thread.id,
    resource_type: "oxrm",
    resource_id: registered.resource.id,
    resource_action: "read",
  };
  return { env, auth, input, principal, thread, resource: registered.resource };
}

test("resource-bound connector tokens intersect token actions with current grants and persist an active session", async () => {
  const item = await fixture();
  const scoped = assertConnectorMcpScope(item.auth, "orkestr_auth", item.input);
  await assertConnectorMcpResourceAccess(scoped, item.input, item.env);
  const state = await readThreadResourcePolicy(item.env);

  assert.equal(state.resourceSessions.length, 1);
  assert.equal(state.resourceSessions[0].state, "active");
  assert.equal(JSON.stringify(state.resourceSessions).includes("resource-execution-jti"), false);
  assert.equal(JSON.stringify(state.resourceSessions).includes("private-bearer-secret"), false);
  const report = await threadResourcePolicyDoctorReport(item.env);
  assert.equal(report.coverage.resourceSessions, "transactional_aggregate");
  assert.equal(JSON.stringify(report).includes(item.resource.id), false);
  assert.equal(JSON.stringify(report).includes("resource-execution-jti"), false);
  await assert.rejects(
    () => assertConnectorMcpResourceAccess(scoped, { ...item.input, resource_action: "execute" }, item.env),
    /connector_mcp_resource_target_scope_denied/,
  );
});

test("resource-bound connector tokens reject stale epochs and invalidate sessions synchronously", async () => {
  const item = await fixture();
  await assertConnectorMcpResourceAccess(item.auth, item.input, item.env);
  await advanceThreadResourceGeneration("oxrm", "crm-primary", "tenant", { principal: item.principal }, item.env);
  const invalidated = await readThreadResourcePolicy(item.env);

  assert.equal(invalidated.resourceSessions[0].state, "invalidated");
  await assert.rejects(
    () => assertConnectorMcpResourceAccess(item.auth, item.input, item.env),
    /connector_mcp_resource_token_stale/,
  );
});

test("resource-bound connector sessions are invalidated when a grant is replaced", async () => {
  const item = await fixture();
  await assertConnectorMcpResourceAccess(item.auth, item.input, item.env);
  await setThreadResourceGrants(item.thread.id, "oxrm", [{ resourceId: "crm-primary", permissions: ["read"] }], { principal: item.principal }, item.env);
  const invalidated = await readThreadResourcePolicy(item.env);

  assert.equal(invalidated.resourceSessions[0].state, "invalidated");
  await assert.rejects(
    () => assertConnectorMcpResourceAccess(item.auth, item.input, item.env),
    /connector_mcp_resource_token_stale/,
  );
});

test("resource-bound connector tokens fail closed for cross-thread, cross-boundary, and target mismatches", async () => {
  const item = await fixture();
  await assert.rejects(
    () => assertConnectorMcpResourceAccess(item.auth, { ...item.input, thread_id: "other-thread" }, item.env),
    /connector_mcp_resource_thread_scope_denied/,
  );
  await assert.rejects(
    () => assertConnectorMcpResourceAccess({ ...item.auth, boundaryId: "other-boundary" }, item.input, item.env),
    /connector_mcp_resource_boundary_denied/,
  );
  await assert.rejects(
    () => assertConnectorMcpResourceAccess(item.auth, { ...item.input, resource_id: "other-resource" }, item.env),
    /connector_mcp_resource_target_scope_denied/,
  );
  await assert.rejects(
    () => assertConnectorMcpResourceAccess(item.auth, { ...item.input, resource_id: "" }, item.env),
    /connector_mcp_resource_target_required/,
  );
  await assert.rejects(
    () => assertConnectorMcpResourceAccess({
      ...item.auth,
      expiresAt: new Date(Date.parse(item.auth.issuedAt) + (6 * 60_000)).toISOString(),
    }, item.input, item.env),
    /connector_mcp_resource_token_ttl_invalid/,
  );
});

test("resource-bound connector token scope never creates a grant", async () => {
  const item = await fixture({ grant: false });
  await assert.rejects(
    () => assertConnectorMcpResourceAccess(item.auth, item.input, item.env),
    /connector_mcp_resource_grant_required/,
  );
  assert.equal((await readThreadResourcePolicy(item.env)).resourceSessions.length, 0);
});

test("configured operator connector token remains compatible without a resource target", async () => {
  const env = { ORKESTR_CONNECTORS_MCP_TOKEN: "operator-token", ORKESTR_OXRM_ACCESS_MODE: "enforce" };
  const auth = await authorizeConnectorMcpToken("operator-token", env);
  const result = await assertConnectorMcpResourceAccess(auth, { service: "whatsapp", action: "status" }, env);

  assert.equal(auth.operator, true);
  assert.equal(result, auth);
});
