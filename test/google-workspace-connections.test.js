import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listGoogleWorkspaceConnections,
  migrateLegacyGoogleWorkspaceConnection,
  removeGoogleWorkspaceConnection,
  resolveGoogleWorkspaceConnection,
  saveGoogleWorkspaceConnectionToken,
  updateGoogleWorkspaceConnection,
} from "../packages/connectors/src/google-workspace-connections.js";
import { runTenantApiAgentGoogleWorkspaceTool } from "../packages/connectors/src/google-workspace-api-agent-tools.js";

async function testEnv(prefix) {
  return { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), prefix)), ORKESTR_ADMIN_USER_ID: "admin" };
}

function token(account, accessToken = `access-${account}`) {
  return {
    accessToken,
    refreshToken: `refresh-${account}`,
    account,
    capabilities: ["gmail_read", "calendar_read"],
    grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

test("legacy Gmail token migrates once into the Google Workspace registry", async () => {
  const env = await testEnv("orkestr-google-registry-legacy-");
  await fs.mkdir(path.join(env.ORKESTR_HOME, "secrets"), { recursive: true });
  await fs.writeFile(path.join(env.ORKESTR_HOME, "secrets", "gmail-token.json"), JSON.stringify(token("main@example.com")));

  const first = await migrateLegacyGoogleWorkspaceConnection(env);
  const second = await migrateLegacyGoogleWorkspaceConnection(env);
  const listed = await listGoogleWorkspaceConnections(env, { includeExplicit: true });

  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.equal(listed.connections.length, 1);
  assert.equal(listed.connections[0].email, "main@example.com");
  assert.equal(listed.connections[0].useMode, "default");
  assert.equal(listed.mainConnectionId, listed.connections[0].connectionId);
  const resolved = await resolveGoogleWorkspaceConnection({}, env);
  assert.equal(resolved.token.accessToken, "access-main@example.com");
  assert.equal(resolved.selectionSource, "user_default");
});

test("Google Workspace agent tools use the explicitly selected connection and report the source", async () => {
  const env = await testEnv("orkestr-google-registry-tools-");
  await saveGoogleWorkspaceConnectionToken({
    ...token("owner@example.com", "owner-access"),
    capabilities: ["calendar_read"],
    grantedScopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
  }, env, { alias: "owner", setAsMain: true });
  const extra = await saveGoogleWorkspaceConnectionToken({
    ...token("can@mayamilk.com", "mayamilk-access"),
    capabilities: ["calendar_read"],
    grantedScopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
  }, env, { alias: "mayamilk", useMode: "explicit_only" });

  const calls = [];
  const executed = await runTenantApiAgentGoogleWorkspaceTool("orkestr_list_google_calendar_events", {
    accountId: extra.connection.connectionId,
    account: "",
    calendarId: "primary",
    timeMin: "",
    timeMax: "",
    maxResults: 5,
  }, {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: options.headers?.authorization });
      return { ok: true, status: 200, async json() { return { items: [] }; } };
    },
  }, env);

  assert.equal(executed.handled, true);
  assert.equal(executed.result.accountId, extra.connection.connectionId);
  assert.equal(executed.result.account, "can@mayamilk.com");
  assert.equal(executed.result.selectionSource, "explicit");
  assert.equal(calls[0].authorization, "Bearer mayamilk-access");
});

test("multiple Google accounts are stored independently and selected deterministically", async () => {
  const env = await testEnv("orkestr-google-registry-multi-");
  const main = await saveGoogleWorkspaceConnectionToken(token("owner@example.com"), env, {
    alias: "owner",
    setAsMain: true,
  });
  const mayamilk = await saveGoogleWorkspaceConnectionToken(token("can@mayamilk.com"), env, {
    alias: "mayamilk",
    useMode: "explicit_only",
  });
  const saim = await saveGoogleWorkspaceConnectionToken(token("saim@example.com"), env, {
    alias: "saim",
    useMode: "explicit_only",
    threadId: "saim-linkedin",
    setAsThreadDefault: true,
  });

  const generic = await listGoogleWorkspaceConnections(env);
  assert.deepEqual(generic.connections.map((connection) => connection.alias), ["owner"]);

  const thread = await listGoogleWorkspaceConnections(env, { threadId: "saim-linkedin" });
  assert.deepEqual(thread.connections.map((connection) => connection.alias).sort(), ["owner", "saim"]);

  const all = await listGoogleWorkspaceConnections(env, { includeExplicit: true });
  assert.equal(all.connections.length, 3);
  assert.equal(new Set(all.connections.map((connection) => connection.connectionId)).size, 3);

  const defaultSelection = await resolveGoogleWorkspaceConnection({}, env);
  assert.equal(defaultSelection.connection.connectionId, main.connection.connectionId);
  assert.equal(defaultSelection.selectionSource, "user_default");

  const explicitSelection = await resolveGoogleWorkspaceConnection({ account: "mayamilk" }, env);
  assert.equal(explicitSelection.connection.connectionId, mayamilk.connection.connectionId);
  assert.equal(explicitSelection.token.accessToken, "access-can@mayamilk.com");
  assert.equal(explicitSelection.selectionSource, "explicit");

  const threadSelection = await resolveGoogleWorkspaceConnection({ threadId: "saim-linkedin" }, env);
  assert.equal(threadSelection.connection.connectionId, saim.connection.connectionId);
  assert.equal(threadSelection.selectionSource, "thread_default");
});

test("the main Google account remains the only default-mode connection", async () => {
  const env = await testEnv("orkestr-google-registry-main-invariant-");
  const owner = await saveGoogleWorkspaceConnectionToken(token("owner@example.com"), env, {
    alias: "owner",
    setAsMain: true,
  });
  const work = await saveGoogleWorkspaceConnectionToken(token("work@example.com"), env, {
    alias: "work",
    useMode: "available",
  });

  await updateGoogleWorkspaceConnection(owner.connection.connectionId, { useMode: "explicit_only" }, env);
  await updateGoogleWorkspaceConnection(work.connection.connectionId, { useMode: "default" }, env);
  const listed = await listGoogleWorkspaceConnections(env, { includeExplicit: true });

  assert.equal(listed.mainConnectionId, work.connection.connectionId);
  assert.equal(listed.connections.find((item) => item.connectionId === work.connection.connectionId).useMode, "default");
  assert.equal(listed.connections.find((item) => item.connectionId === owner.connection.connectionId).useMode, "available");
});

test("a missing explicitly selected account never falls back to the main account", async () => {
  const env = await testEnv("orkestr-google-registry-no-fallback-");
  await saveGoogleWorkspaceConnectionToken(token("owner@example.com"), env, { setAsMain: true });
  const extra = await saveGoogleWorkspaceConnectionToken(token("extra@example.com"), env, { useMode: "explicit_only" });
  await removeGoogleWorkspaceConnection(extra.connection.connectionId, env);

  await assert.rejects(
    resolveGoogleWorkspaceConnection({ connectionId: extra.connection.connectionId }, env),
    (error) => error.code === "connector_account_not_found",
  );
  const selected = await resolveGoogleWorkspaceConnection({}, env);
  assert.equal(selected.connection.email, "owner@example.com");
});

test("an unhealthy explicit account requires reconnect without poisoning the main account", async () => {
  const env = await testEnv("orkestr-google-registry-health-");
  await saveGoogleWorkspaceConnectionToken(token("owner@example.com"), env, { setAsMain: true });
  const extra = await saveGoogleWorkspaceConnectionToken(token("extra@example.com"), env, {
    alias: "extra",
    useMode: "explicit_only",
  });
  await updateGoogleWorkspaceConnection(extra.connection.connectionId, {
    healthState: "reauth_required",
    lastErrorCode: "gmail_reauthorization_required",
  }, env);

  await assert.rejects(
    resolveGoogleWorkspaceConnection({ connectionId: extra.connection.connectionId }, env),
    (error) => error.code === "reconnect_required",
  );
  const selected = await resolveGoogleWorkspaceConnection({}, env);
  assert.equal(selected.connection.email, "owner@example.com");
  assert.equal(selected.selectionSource, "user_default");
});
