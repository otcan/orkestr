import { readJson, writeJson } from "../../storage/src/store.js";
import { connectorFile, connectorScopePaths } from "./connector-storage.js";

const fileName = "google-workspace-review-audit.json";
const allowedActions = new Set([
  "google_connect_requested",
  "google_connected",
  "gmail_messages_listed",
  "gmail_message_read",
  "gmail_draft_created",
  "gmail_message_sent",
  "calendar_events_listed",
  "calendar_event_created",
]);

function clean(value = "") {
  return String(value || "").trim();
}

function publicEvent(event = {}) {
  return {
    at: clean(event.at),
    action: clean(event.action),
    state: clean(event.state) || "completed",
  };
}

async function auditFile(env = process.env, options = {}) {
  const scope = await connectorScopePaths(env, options);
  return connectorFile(scope, "oauth", fileName);
}

export async function listGoogleWorkspaceReviewAudit(env = process.env, options = {}) {
  const filePath = await auditFile(env, options);
  const stored = await readJson(filePath, { events: [] });
  return (Array.isArray(stored.events) ? stored.events : [])
    .map(publicEvent)
    .filter((event) => event.at && allowedActions.has(event.action))
    .slice(-50)
    .reverse();
}

export async function appendGoogleWorkspaceReviewAudit(action = "", env = process.env, options = {}) {
  const normalizedAction = clean(action);
  if (!allowedActions.has(normalizedAction)) return null;
  const filePath = await auditFile(env, options);
  const stored = await readJson(filePath, { events: [] });
  const events = (Array.isArray(stored.events) ? stored.events : [])
    .map(publicEvent)
    .filter((event) => event.at && allowedActions.has(event.action));
  const event = { at: new Date().toISOString(), action: normalizedAction, state: "completed" };
  await writeJson(filePath, { schemaVersion: 1, events: [...events, event].slice(-100), updatedAt: event.at });
  return event;
}
