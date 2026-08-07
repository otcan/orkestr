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
import { issueConnectorMcpResourceToken } from "../packages/core/src/thread-resource-sessions.js";
import { threadResourcePolicyDoctorReport } from "../packages/core/src/thread-resource-policy-doctor.js";
import { withThreadResourcePolicyTransaction } from "../packages/core/src/thread-resource-policy-store.js";

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
    connectorService: "whatsapp",
    connectorAccountId: "account-a",
    connectorConversationId: "conversation-a",
    connectorBindingId: "binding-a",
    connectorTargetThreadId: thread.id,
    connectorOperationRef: "operation-a",
    allowedChatIds: ["conversation-a"],
    connectorMcpTool: "orkestr_auth",
    connectorMcpAction: "status",
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
      policyRevision: state.policies.find((policy) => policy.threadId === thread.id && policy.resourceType === "oxrm")?.revision || 0,
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
    account_id: "account-a",
    conversation_id: "conversation-a",
    binding_id: "binding-a",
    target_thread_id: thread.id,
    operation_ref: "operation-a",
    resource_type: "oxrm",
    resource_id: registered.resource.id,
    resource_action: "read",
    connector_mcp_tool: "orkestr_auth",
    connector_mcp_action: "status",
  };
  return { env, auth, input, principal, thread, resource: registered.resource };
}

function issueInput(item, overrides = {}) {
  return {
    resourceType: "oxrm", resourceId: item.resource.id, resourceAction: "read", threadId: item.thread.id,
    principal: item.principal, connectorMcpTool: "orkestr_auth", connectorMcpAction: "status",
    service: "whatsapp", accountId: "account-a", conversationId: "conversation-a", bindingId: "binding-a",
    targetThreadId: item.thread.id, operationRef: "operation-a",
    ...overrides,
  };
}

function assertResourceAccess(auth, input, env) {
  return assertConnectorMcpResourceAccess(auth, input, env, { actualTarget: input });
}

test("resource-bound connector tokens intersect token actions with current grants and persist an active session", async () => {
  const item = await fixture();
  const scoped = assertConnectorMcpScope(item.auth, "orkestr_auth", item.input);
  await assertResourceAccess(scoped, item.input, item.env);
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
    () => assertResourceAccess(scoped, { ...item.input, resource_action: "execute" }, item.env),
    /connector_mcp_resource_target_scope_denied/,
  );
});

test("resource-bound connector tokens reject stale epochs and invalidate sessions synchronously", async () => {
  const item = await fixture();
  await assertResourceAccess(item.auth, item.input, item.env);
  await advanceThreadResourceGeneration("oxrm", "crm-primary", "tenant", { principal: item.principal }, item.env);
  const invalidated = await readThreadResourcePolicy(item.env);

  assert.equal(invalidated.resourceSessions[0].state, "invalidated");
  await assert.rejects(
    () => assertResourceAccess(item.auth, item.input, item.env),
    /connector_mcp_resource_token_stale/,
  );
});

test("resource-bound connector sessions are invalidated when a grant is replaced", async () => {
  const item = await fixture();
  await assertResourceAccess(item.auth, item.input, item.env);
  await setThreadResourceGrants(item.thread.id, "oxrm", [{ resourceId: "crm-primary", permissions: ["read"] }], { principal: item.principal }, item.env);
  const invalidated = await readThreadResourcePolicy(item.env);

  assert.equal(invalidated.resourceSessions[0].state, "invalidated");
  await assert.rejects(
    () => assertResourceAccess(item.auth, item.input, item.env),
    /connector_mcp_resource_token_stale/,
  );
});

test("resource-bound connector tokens fail closed for cross-thread, cross-boundary, and target mismatches", async () => {
  const item = await fixture();
  await assert.rejects(
    () => assertConnectorMcpResourceAccess(item.auth, item.input, item.env),
    /connector_mcp_resource_dispatch_target_unbound/,
  );
  await assert.rejects(
    () => assertResourceAccess(item.auth, { ...item.input, thread_id: "other-thread" }, item.env),
    /connector_mcp_resource_thread_scope_denied/,
  );
  await assert.rejects(
    () => assertResourceAccess({ ...item.auth, boundaryId: "other-boundary" }, item.input, item.env),
    /connector_mcp_resource_boundary_denied/,
  );
  await assert.rejects(
    () => assertResourceAccess({ ...item.auth, audience: "other-mcp" }, item.input, item.env),
    /connector_mcp_resource_audience_denied/,
  );
  await assert.rejects(
    () => assertResourceAccess(item.auth, { ...item.input, resource_id: "other-resource" }, item.env),
    /connector_mcp_resource_target_scope_denied/,
  );
  await assert.rejects(
    () => assertConnectorMcpResourceAccess(item.auth, { ...item.input, resource_id: "other-resource" }, item.env, { actualTarget: item.input }),
    /connector_mcp_resource_dispatch_target_mismatch/,
  );
  await assert.rejects(
    () => assertResourceAccess(item.auth, { ...item.input, connector_mcp_tool: "orkestr_conversation" }, item.env),
    /connector_mcp_resource_dispatch_scope_denied/,
  );
  await assert.rejects(
    () => assertResourceAccess(item.auth, { ...item.input, action: "list" }, item.env),
    /connector_mcp_resource_dispatch_scope_denied/,
  );
  for (const [field, value] of [
    ["service", "gmail"],
    ["account_id", "account-b"],
    ["conversation_id", "conversation-b"],
    ["binding_id", "binding-b"],
    ["target_thread_id", "other-thread"],
    ["operation_ref", "operation-b"],
  ]) {
    await assert.rejects(
      () => assertResourceAccess(item.auth, { ...item.input, [field]: value }, item.env),
      /connector_mcp_resource_operation_target_scope_denied/,
      `resource token must bind ${field}`,
    );
    await assert.rejects(
      () => assertConnectorMcpResourceAccess(item.auth, { ...item.input, [field]: value }, item.env, { actualTarget: item.input }),
      /connector_mcp_resource_dispatch_target_mismatch/,
      `caller cannot contradict trusted ${field}`,
    );
  }
  await assert.rejects(
    () => assertResourceAccess(item.auth, { ...item.input, resource_id: "" }, item.env),
    /connector_mcp_resource_target_required/,
  );
  await assert.rejects(
    () => assertResourceAccess({
      ...item.auth,
      expiresAt: new Date(Date.parse(item.auth.issuedAt) + (6 * 60_000)).toISOString(),
    }, item.input, item.env),
    /connector_mcp_resource_token_ttl_invalid/,
  );
});

test("resource-bound connector token scope never creates a grant", async () => {
  const item = await fixture({ grant: false });
  await assert.rejects(
    () => assertResourceAccess(item.auth, item.input, item.env),
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

test("issued resource tokens round-trip through connector auth and survive unrelated policy edits", async () => {
  const item = await fixture();
  const issued = await issueConnectorMcpResourceToken(issueInput(item, { scopes: ["connectors:read"], instanceId: "tenant-instance" }), item.env);
  // Issued sessions are independently usable; they do not rely on a static
  // environment token record remaining configured after issuance.
  item.env.ORKESTR_CONNECTORS_MCP_TOKENS_JSON = "";
  const auth = await authorizeConnectorMcpToken(issued.token, item.env);

  assert.match(issued.token, /^rt_[A-Za-z0-9_-]+$/);
  assert.equal(auth.resourceId, item.resource.id);
  assert.equal(auth.audience, "orkestr-connectors-mcp");
  await assertResourceAccess(auth, item.input, item.env);
  const unrelated = await createThread({ id: "unrelated-resource-thread", name: "Unrelated", ownerUserId: "tenant" }, item.env);
  await registerThreadResource({ resourceType: "oxrm", resourceId: "crm-unrelated", ownerUserId: "tenant", status: "active" }, { principal: item.principal }, item.env);
  await setThreadResourceGrants(unrelated.id, "oxrm", [{ resourceId: "crm-unrelated", permissions: ["read"] }], { principal: item.principal }, item.env);
  const afterUnrelatedEdit = await readThreadResourcePolicy(item.env);

  assert.equal(afterUnrelatedEdit.resourceSessions[0].state, "active");
  assert.equal(afterUnrelatedEdit.resourceSessions[0].audience, "orkestr-connectors-mcp");
  await assertResourceAccess(await authorizeConnectorMcpToken(issued.token, item.env), item.input, item.env);
  assert.equal(JSON.stringify(afterUnrelatedEdit.resourceSessions).includes(issued.token), false);
  await assert.rejects(() => authorizeConnectorMcpToken(`${issued.token}x`, item.env), /connector_mcp_token_invalid/);
});

test("issued resource tokens enforce lifetime and are revoked with their effective grant", async () => {
  const item = await fixture();
  await assert.rejects(
    () => issueConnectorMcpResourceToken(issueInput(item, { service: "" }), item.env),
    /connector_mcp_resource_token_issue_target_invalid/,
  );
  await assert.rejects(
    () => issueConnectorMcpResourceToken(issueInput(item, { ttlMs: 0 }), item.env),
    /connector_mcp_resource_token_ttl_invalid/,
  );
  await assert.rejects(
    () => issueConnectorMcpResourceToken(issueInput(item, { ttlMs: 5 * 60_000 + 1 }), item.env),
    /connector_mcp_resource_token_ttl_invalid/,
  );
  const issued = await issueConnectorMcpResourceToken(issueInput(item), item.env);
  await withThreadResourcePolicyTransaction((state) => {
    state.resourceSessions[0].expiresAt = new Date(Date.now() - 1_000).toISOString();
    return { state };
  }, item.env);
  await assert.rejects(() => authorizeConnectorMcpToken(issued.token, item.env), /connector_mcp_token_invalid/);

  const active = await issueConnectorMcpResourceToken(issueInput(item), item.env);
  await setThreadResourceGrants(item.thread.id, "oxrm", [], { principal: item.principal }, item.env);
  const state = await readThreadResourcePolicy(item.env);
  assert.equal(state.resourceSessions.some((session) => session.bearerHash && session.state === "invalidated"), true);
  await assert.rejects(() => authorizeConnectorMcpToken(active.token, item.env), /connector_mcp_token_invalid/);
});

test("parent grant replacement invalidates an inherited child session through grantThreadId", async () => {
  const item = await fixture();
  const parent = await createThread({ id: "resource-source-parent", name: "Resource source parent", ownerUserId: "tenant" }, item.env);
  await setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "crm-primary", permissions: ["read"] }], { principal: item.principal }, item.env);
  const child = await createThread({ id: "resource-source-child", name: "Resource source child", ownerUserId: "tenant", parentThreadId: parent.id }, item.env);
  await issueConnectorMcpResourceToken(issueInput(item, { threadId: child.id, targetThreadId: child.id }), item.env);
  const active = await readThreadResourcePolicy(item.env);

  assert.equal(active.resourceSessions[0].grantThreadId, parent.id);
  await setThreadResourceGrants(parent.id, "oxrm", [], { principal: item.principal }, item.env);
  assert.equal((await readThreadResourcePolicy(item.env)).resourceSessions[0].state, "invalidated");
});
