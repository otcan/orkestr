import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGoogleCalendarEvent,
  createGmailDraft,
  createGoogleWorkspaceConnectLink,
  deleteGoogleCalendarEvent,
  getGoogleDriveFile,
  getGoogleWorkspaceConnectRequest,
  googleWorkspaceConnectHtml,
  listGoogleCalendarEvents,
  modifyGmailMessage,
  sendGmailDraft,
  startGoogleWorkspaceOAuth,
  updateGoogleCalendarEvent,
} from "../packages/connectors/src/google-workspace.js";
import {
  googleWorkspaceCapabilitiesForScopes,
  googleWorkspaceScopesForCapabilities,
  normalizeGoogleWorkspaceCapabilities,
} from "../packages/connectors/src/google-workspace-scopes.js";
import { exchangeGmailCode, finishGmailOAuth, readGmailToken } from "../packages/connectors/src/gmail.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { connectorAuthStatus } from "../packages/connectors/src/connector-auth.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { userDataPaths } from "../packages/storage/src/paths.js";

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function textResponse(text, ok = true, status = 200) {
  return {
    ok,
    status,
    async text() {
      return text;
    },
  };
}

async function configureGoogle(home) {
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.example.test",
  };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/oauth/gmail/callback",
  }, env);
  return env;
}

async function storeToken(env, scope, principal = null) {
  await exchangeGmailCode(
    "code-123",
    env,
    async () =>
      jsonResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope,
      }),
    principal ? { principal } : {},
  );
}

test("google workspace scope selection maps only requested capabilities", () => {
  const capabilities = normalizeGoogleWorkspaceCapabilities(["gmail_send", "calendar_read", "calendar_actions", "drive_file"]);
  const scopes = googleWorkspaceScopesForCapabilities(capabilities);

  assert.deepEqual(capabilities, ["gmail_send", "calendar_read", "calendar_actions", "drive_file"]);
  assert.ok(scopes.includes("openid"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.send"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.compose"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events.readonly"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/drive.file"));
  assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.modify"), false);
  assert.equal(scopes.includes("https://www.googleapis.com/auth/drive.readonly"), false);

  assert.deepEqual(
    googleWorkspaceCapabilitiesForScopes("openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly"),
    ["gmail_read", "calendar_read"],
  );
});

test("whatsapp google connect link starts user-scoped oauth with selected scopes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-start-"));
  const env = await configureGoogle(home);
  const alice = userPrincipal({ id: "alice" });

  const link = await createGoogleWorkspaceConnectLink({
    principal: alice,
    thread: {
      id: "thread-1",
      binding: { chatId: "wa-chat", responderAccountId: "wa-responder" },
    },
  }, env);
  assert.match(link.link, /^https:\/\/connect\.example\.test\/connect\/google\?connect=/);

  const request = await getGoogleWorkspaceConnectRequest(link.connectId, env);
  assert.equal(request.ok, true);
  assert.equal(request.request.userId, "alice");

  const started = await startGoogleWorkspaceOAuth(env, {
    connectId: link.connectId,
    capabilities: ["gmail_read", "calendar_read"],
  });
  const statePath = path.join(userDataPaths("alice", env).oauth, "gmail-state.json");
  const savedState = JSON.parse(await fs.readFile(statePath, "utf8"));
  const url = new URL(started.authorizeUrl);
  const scopes = url.searchParams.get("scope").split(/\s+/g);

  assert.equal(savedState.provider, "google_workspace");
  assert.equal(savedState.threadId, "thread-1");
  assert.equal(savedState.chatId, "wa-chat");
  assert.deepEqual(savedState.requestedCapabilities, ["gmail_read", "calendar_read"]);
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.readonly"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events.readonly"));
  assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.modify"), false);
  assert.equal(scopes.includes("https://www.googleapis.com/auth/drive.file"), false);
});

test("google workspace callback stores only granted partial capabilities", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-partial-"));
  const env = await configureGoogle(home);
  const alice = userPrincipal({ id: "alice" });
  const link = await createGoogleWorkspaceConnectLink({ principal: alice, thread: { id: "thread-1" } }, env);
  const started = await startGoogleWorkspaceOAuth(env, {
    connectId: link.connectId,
    capabilities: ["gmail_read", "gmail_actions", "gmail_send", "calendar_read", "calendar_actions", "drive_file"],
  });

  const result = await finishGmailOAuth(
    new URLSearchParams({ code: "callback-code", state: started.state }),
    env,
    async () =>
      jsonResponse({
        access_token: "partial-access",
        refresh_token: "partial-refresh",
        expires_in: 3600,
        scope: [
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar.events.readonly",
          "https://www.googleapis.com/auth/calendar.events",
        ].join(" "),
      }),
  );
  const token = await readGmailToken(env, { principal: alice });
  const status = await connectorAuthStatus("gmail", env, { principal: alice });

  assert.equal(result.provider, "google_workspace");
  assert.deepEqual(result.capabilities, ["gmail_read", "calendar_read", "calendar_actions"]);
  assert.deepEqual(token.capabilities, ["gmail_read", "calendar_read", "calendar_actions"]);
  assert.deepEqual(status.capabilities, ["gmail_read", "calendar_read", "calendar_actions"]);
});

test("gmail action and draft helpers build scoped Gmail requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-gmail-actions-"));
  const env = await configureGoogle(home);
  await storeToken(
    env,
    [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.compose",
    ].join(" "),
  );

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(String(url)), options });
    if (String(url).includes("/messages/m1/modify")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { addLabelIds: [], removeLabelIds: ["INBOX"] });
      return jsonResponse({ id: "m1", labelIds: [] });
    }
    if (String(url).includes("/drafts/send")) {
      assert.deepEqual(JSON.parse(options.body), { id: "draft-1" });
      return jsonResponse({ id: "sent-1" });
    }
    if (String(url).endsWith("/drafts")) {
      const body = JSON.parse(options.body);
      const raw = Buffer.from(body.message.raw, "base64url").toString("utf8");
      assert.match(raw, /^To: person@example\.com\r\nSubject: Hello\r\n/m);
      assert.match(raw, /Draft body/);
      return jsonResponse({ id: "draft-1" });
    }
    throw new Error(`unexpected_url:${url}`);
  };

  await modifyGmailMessage({ messageId: "m1", action: "archive" }, env, fetchImpl);
  await createGmailDraft({ to: "person@example.com", subject: "Hello", body: "Draft body" }, env, fetchImpl);
  await sendGmailDraft({ draftId: "draft-1" }, env, fetchImpl);

  assert.equal(calls[0].url.pathname, "/gmail/v1/users/me/messages/m1/modify");
  assert.equal(calls[1].url.pathname, "/gmail/v1/users/me/drafts");
  assert.equal(calls[2].url.pathname, "/gmail/v1/users/me/drafts/send");
});

test("calendar and drive helpers build scoped google workspace requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-calendar-drive-"));
  const env = await configureGoogle(home);
  await storeToken(
    env,
    [
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/drive.file",
    ].join(" "),
  );

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(String(url)), options });
    const parsed = new URL(String(url));
    if (parsed.pathname === "/calendar/v3/calendars/primary/events" && (!options.method || options.method === "GET")) {
      assert.equal(parsed.searchParams.get("timeMin"), "2026-06-04T00:00:00Z");
      assert.equal(parsed.searchParams.get("timeMax"), "2026-06-05T00:00:00Z");
      return jsonResponse({ items: [{ id: "event-1", summary: "Planning" }] });
    }
    if (parsed.pathname === "/calendar/v3/calendars/primary/events" && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(parsed.searchParams.get("sendUpdates"), "none");
      assert.equal(body.summary, "Demo");
      assert.deepEqual(body.start, { dateTime: "2026-06-04T12:00:00Z" });
      assert.deepEqual(body.end, { dateTime: "2026-06-04T12:30:00Z" });
      return jsonResponse({ id: "event-2", summary: "Demo" });
    }
    if (parsed.pathname === "/calendar/v3/calendars/primary/events/event-2" && options.method === "PATCH") {
      const body = JSON.parse(options.body);
      assert.equal(body.summary, "Updated demo");
      return jsonResponse({ id: "event-2", summary: "Updated demo" });
    }
    if (parsed.pathname === "/calendar/v3/calendars/primary/events/event-2" && options.method === "DELETE") {
      assert.equal(parsed.searchParams.get("sendUpdates"), "none");
      return jsonResponse({}, true, 204);
    }
    if (parsed.pathname === "/drive/v3/files/file-1" && !parsed.searchParams.get("alt")) {
      assert.equal(parsed.searchParams.get("fields"), "id,name,mimeType,size,modifiedTime,webViewLink");
      return jsonResponse({ id: "file-1", name: "Notes.txt", mimeType: "text/plain" });
    }
    if (parsed.pathname === "/drive/v3/files/file-1" && parsed.searchParams.get("alt") === "media") {
      return textResponse("Drive file contents");
    }
    throw new Error(`unexpected_url:${url}`);
  };

  const events = await listGoogleCalendarEvents({
    calendarId: "primary",
    timeMin: "2026-06-04T00:00:00Z",
    timeMax: "2026-06-05T00:00:00Z",
    maxResults: 5,
  }, env, fetchImpl);
  const created = await createGoogleCalendarEvent({
    calendarId: "primary",
    summary: "Demo",
    startDateTime: "2026-06-04T12:00:00Z",
    endDateTime: "2026-06-04T12:30:00Z",
    sendUpdates: "none",
  }, env, fetchImpl);
  const updated = await updateGoogleCalendarEvent({
    calendarId: "primary",
    eventId: "event-2",
    summary: "Updated demo",
  }, env, fetchImpl);
  const deleted = await deleteGoogleCalendarEvent({
    calendarId: "primary",
    eventId: "event-2",
    sendUpdates: "none",
  }, env, fetchImpl);
  const file = await getGoogleDriveFile({ fileId: "file-1", includeContent: true }, env, fetchImpl);

  assert.equal(events.events[0].id, "event-1");
  assert.equal(created.event.id, "event-2");
  assert.equal(updated.event.summary, "Updated demo");
  assert.equal(deleted.eventId, "event-2");
  assert.equal(file.file.name, "Notes.txt");
  assert.equal(file.content, "Drive file contents");
});

test("google workspace disclosure html names capabilities and drive.file limit", () => {
  const html = googleWorkspaceConnectHtml({ connectId: "connect-1", request: { account: "user@example.com" } });
  assert.match(html, /Connect Google Workspace/);
  assert.match(html, /name="account"/);
  assert.match(html, /type="email"/);
  assert.match(html, /value="user@example\.com"/);
  assert.match(html, /required/);
  assert.match(html, /Gmail read/);
  assert.match(html, /Calendar read/);
  assert.match(html, /Calendar actions/);
  assert.match(html, /Drive selected files/);
  assert.match(html, /Drive uses selected-file access only/);
});
