import {
  googleWorkspaceAllowedCapabilities,
  googleWorkspaceCapabilityDefinitions,
  googleWorkspaceDefaultGmailCapabilities,
  normalizeGoogleWorkspaceCapabilities,
} from "./google-workspace-scopes.js";
import { googleWorkspacePrivacyPolicyVersion } from "./google-workspace-privacy.js";

function clean(value) {
  return String(value || "").trim();
}

function escapeHtml(value = "") {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const restrictedCapabilities = new Set(["gmail_read", "gmail_actions", "gmail_drafts"]);
const sensitiveCapabilities = new Set(["gmail_send", "calendar_read", "calendar_actions"]);

function capabilityRisk(id = "") {
  if (restrictedCapabilities.has(id)) return "Restricted";
  if (sensitiveCapabilities.has(id)) return "Sensitive";
  return "Limited";
}

function selectedCapabilityDefinitions(selectedCapabilities = [], allowedCapabilities = []) {
  const selected = new Set(normalizeGoogleWorkspaceCapabilities(selectedCapabilities, googleWorkspaceDefaultGmailCapabilities()));
  const allowed = new Set(allowedCapabilities);
  return googleWorkspaceCapabilityDefinitions()
    .filter((definition) => selected.has(definition.id) && allowed.has(definition.id));
}

function googleAccessNotice(selectedCapabilities = [], allowedCapabilities = []) {
  const selected = selectedCapabilityDefinitions(selectedCapabilities, allowedCapabilities);
  if (selected.length === 1 && selected[0].id === "gmail_send") {
    return "<strong>Selected permission:</strong> Gmail send. Orkestr can send an email only after you request or approve it. This permission cannot read your inbox or existing email.";
  }
  if (!selected.length) {
    return "<strong>Select access:</strong> Choose only the Google Workspace capabilities you want Orkestr to use.";
  }
  const labels = selected.map((definition) => escapeHtml(definition.label)).join(", ");
  return `<strong>Selected permissions:</strong> ${labels}. Orkestr will use only the capabilities you select and Google grants.`;
}

function googleDataUseDisclosure(selectedCapabilities = [], allowedCapabilities = []) {
  const selected = new Set(selectedCapabilityDefinitions(selectedCapabilities, allowedCapabilities).map((definition) => definition.id));
  const lines = [
    "Orkestr receives your basic Google account identity, OAuth grant, and encrypted access credentials.",
  ];
  if (selected.has("gmail_send")) {
    lines.push("For Gmail send, it processes the recipients, subject, body, and attachments you request or approve.");
  }
  if (selected.has("gmail_drafts")) {
    lines.push("For Gmail drafts, it processes draft recipients, subject, body, attachments, and Gmail draft identifiers that you ask it to create or send.");
  }
  if (selected.has("gmail_read")) {
    lines.push("For Gmail read, it can search message metadata and retrieve message content when you ask it to read or summarize email.");
  }
  if (selected.has("gmail_actions")) {
    lines.push("For Gmail actions, it can change labels, archive messages, and mark messages read or unread when you request those changes.");
  }
  if (selected.has("calendar_read")) {
    lines.push("For Calendar read, it can retrieve event details for date ranges you request.");
  }
  if (selected.has("calendar_actions")) {
    lines.push("For Calendar actions, it can create, update, or delete events on calendars you own after you approve the effective event details.");
  }
  if (selected.has("drive_file")) {
    lines.push("For Drive selected files, it can access only files selected or created through Orkestr.");
  }
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function capabilityControls(
  selectedCapabilities = googleWorkspaceDefaultGmailCapabilities(),
  allowedCapabilities = googleWorkspaceDefaultGmailCapabilities(),
) {
  const selected = new Set(normalizeGoogleWorkspaceCapabilities(selectedCapabilities, googleWorkspaceDefaultGmailCapabilities()));
  const allowed = new Set(allowedCapabilities);
  return googleWorkspaceCapabilityDefinitions()
    .filter((definition) => allowed.has(definition.id))
    .map((definition) => {
      const checked = selected.has(definition.id) ? " checked" : "";
      return `<label class="capability">
          <input type="checkbox" name="capability" value="${escapeHtml(definition.id)}"${checked}>
          <span>
            <strong>${escapeHtml(definition.label)}</strong>
            <small>${escapeHtml(definition.summary)}</small>
            <em>${escapeHtml(capabilityRisk(definition.id))}</em>
          </span>
        </label>`;
    })
    .join("");
}

export function googleWorkspaceConnectHtml({
  connectId = "",
  request = {},
  error = "",
  previewOnly = false,
  selectedCapabilities = googleWorkspaceDefaultGmailCapabilities(),
  allowedCapabilities = "",
  env = process.env,
} = {}) {
  const safeConnect = escapeHtml(connectId);
  const allowed = googleWorkspaceAllowedCapabilities(env, allowedCapabilities);
  const hidden = `<input type="hidden" name="connect" value="${safeConnect}">`;
  const contextRows = [
    ["Tool", "orkestr_auth"],
    ["Service", "gmail"],
    ["Provider", "google_workspace"],
    ["OAuth app", request?.oauthAppId || "default"],
    ["Action", "connect"],
    ["Instance", request?.brokerInstanceId || request?.brokerTenantVmId || ""],
    ["User", request?.userId || request?.brokerTenantUserId || ""],
    ["Thread", request?.threadName || request?.threadTitle || request?.threadId || request?.brokerTenantThreadId || ""],
  ]
    .filter(([, value]) => clean(value))
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  const content = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : previewOnly
      ? `<p class="notice">Open this link in a browser to approve this Gmail connection. Link previews cannot start authorization.</p>`
    : `<form method="get" action="/connect/google/start">
        ${hidden}
        <input type="hidden" name="capabilities_selected" value="1">
        <input type="hidden" name="privacy_policy_version" value="${googleWorkspacePrivacyPolicyVersion}">
        <fieldset>
          <legend>Google access</legend>
          <p class="notice">${googleAccessNotice(selectedCapabilities, allowed)}</p>
          <div class="capabilities">${capabilityControls(selectedCapabilities, allowed)}</div>
        </fieldset>
        <section class="disclosure" aria-labelledby="data-use-title">
          <h2 id="data-use-title">How your Google data is handled</h2>
          ${googleDataUseDisclosure(selectedCapabilities, allowed)}
          <p>Credentials are encrypted at rest and are never sent to an AI provider. Orkestr does not sell Google user data, use it for advertising, or use it to train generalized AI models. Service providers receive data only as needed to deliver your requested workflow, operate the service securely, or comply with law.</p>
          <p>You can disconnect Google at any time to revoke Orkestr's access and delete the stored credentials. Read the <a href="/privacy#google-data-access">Google data disclosure</a>, <a href="/privacy#google-data-sharing">sharing disclosure</a>, and <a href="/privacy#google-data-protection">protection disclosure</a>.</p>
        </section>
        <label class="consent">
          <input type="checkbox" name="privacy_consent" value="1" required>
          <span>I understand the Google data use described above and choose to continue to Google's consent screen.</span>
        </label>
        <button type="submit">Continue to Google</button>
      </form>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Google Workspace</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; color: #172026; background: #f7f8f8; }
    main { max-width: 720px; margin: 0 auto; padding: 40px 20px; }
    h1 { font-size: 32px; line-height: 1.15; margin: 0 0 12px; letter-spacing: 0; }
    p { line-height: 1.5; }
    .context { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 18px 0; }
    .context div { border: 1px solid #d3d8dc; border-radius: 8px; background: white; padding: 10px; }
    .context dt { color: #52606d; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .context dd { margin: 4px 0 0; overflow-wrap: anywhere; }
    .notice { color: #3f4d59; background: #e8f1ee; border: 1px solid #c6ded3; border-radius: 8px; padding: 12px; }
    .error { color: #842029; background: #f8d7da; border: 1px solid #f1aeb5; border-radius: 8px; padding: 12px; }
    fieldset { border: 1px solid #d3d8dc; border-radius: 8px; background: white; margin: 18px 0; padding: 14px; }
    legend { color: #172026; font-weight: 800; padding: 0 6px; }
    .capabilities { display: grid; gap: 8px; margin: 12px 0 0; }
    .capability { display: grid; grid-template-columns: 20px 1fr; gap: 10px; align-items: start; border: 1px solid #e1e5e8; border-radius: 8px; padding: 10px; cursor: pointer; }
    .capability input { margin-top: 3px; }
    .capability span { display: grid; gap: 4px; }
    .capability small { color: #52606d; line-height: 1.35; }
    .capability em { color: #495057; font-size: 12px; font-style: normal; font-weight: 800; text-transform: uppercase; }
    .disclosure { border: 1px solid #d3d8dc; border-radius: 8px; background: white; margin: 18px 0; padding: 16px; }
    .disclosure h2 { margin: 0 0 10px; font-size: 20px; }
    .disclosure p { margin: 8px 0; color: #3f4d59; }
    .disclosure a { color: #14532d; font-weight: 700; }
    .consent { display: grid; grid-template-columns: 20px 1fr; gap: 10px; align-items: start; margin: 18px 0; line-height: 1.45; }
    .consent input { margin-top: 4px; }
    button { appearance: none; border: 0; border-radius: 6px; padding: 12px 16px; background: #14532d; color: white; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Connect Google Workspace</h1>
    ${contextRows ? `<dl class="context">${contextRows}</dl>` : ""}
    ${content}
  </main>
</body>
</html>`;
}
