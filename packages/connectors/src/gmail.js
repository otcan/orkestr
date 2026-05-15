import { randomUUID } from "node:crypto";
import { readConnectorConfig } from "../../storage/src/config.js";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, writeJson, writeSecretJson } from "../../storage/src/store.js";

const gmailScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

export async function startGmailOAuth(env = process.env) {
  const config = await readConnectorConfig("gmail", env);
  const clientId = String(config.clientId || "").trim();
  const redirectUri = String(config.redirectUri || "").trim();
  if (!clientId || !redirectUri) {
    const error = new Error("gmail_oauth_config_required");
    error.statusCode = 400;
    throw error;
  }
  const paths = await ensureDataDirs(env);
  const state = randomUUID();
  await writeJson(`${paths.oauth}/gmail-state.json`, {
    state,
    createdAt: new Date().toISOString(),
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", gmailScopes.join(" "));
  url.searchParams.set("state", state);
  await appendEvent({ type: "gmail_oauth_started" }, env);
  return { authorizeUrl: url.toString(), state, redirectUri };
}

export async function finishGmailOAuth(query, env = process.env) {
  const paths = await ensureDataDirs(env);
  const payload = {
    code: String(query.get("code") || ""),
    state: String(query.get("state") || ""),
    scope: String(query.get("scope") || ""),
    receivedAt: new Date().toISOString(),
  };
  if (!payload.code) {
    const error = new Error("gmail_oauth_code_required");
    error.statusCode = 400;
    throw error;
  }
  await writeSecretJson(`${paths.secrets}/gmail-oauth.json`, payload);
  await appendEvent({ type: "gmail_oauth_callback_received" }, env);
  return { ok: true, state: payload.state, receivedAt: payload.receivedAt };
}

