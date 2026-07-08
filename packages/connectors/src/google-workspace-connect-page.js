import { googleWorkspaceCapabilityDefinitions } from "./google-workspace-scopes.js";

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

export function googleWorkspaceConnectHtml({ connectId = "", request = {}, error = "", previewOnly = false } = {}) {
  const capabilities = googleWorkspaceCapabilityDefinitions();
  const safeConnect = escapeHtml(connectId);
  const safeAccount = escapeHtml(request?.account || "");
  const hidden = `<input type="hidden" name="connect" value="${safeConnect}">`;
  const contextRows = [
    ["Tool", "orkestr_auth"],
    ["Service", "gmail"],
    ["Provider", "google_workspace"],
    ["Action", "connect"],
    ["Instance", request?.brokerInstanceId || request?.brokerTenantVmId || ""],
    ["User", request?.userId || request?.brokerTenantUserId || ""],
    ["Thread", request?.threadId || request?.brokerTenantThreadId || ""],
    ["Account", request?.account || ""],
  ]
    .filter(([, value]) => clean(value))
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  const rows = capabilities.map((capability, index) => {
    const checked = index === 0 ? " checked" : "";
    return `<label class="option"><input type="checkbox" name="capability" value="${escapeHtml(capability.id)}"${checked}> <strong>${escapeHtml(capability.label)}</strong><span>${escapeHtml(capability.summary)}</span></label>`;
  }).join("");
  const content = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : previewOnly
      ? `<p class="notice">Open this link in a browser to approve this Gmail connection. Link previews cannot start authorization.</p>`
    : `<p>Choose the Google Workspace capabilities Orkestr may use for this chat before continuing to Google OAuth.</p>
      <form method="get" action="/connect/google/start">
        ${hidden}
        <label class="field"><strong>Google account email</strong><input type="email" name="account" value="${safeAccount}" autocomplete="email" required></label>
        <div class="options">${rows}</div>
        <p class="notice">Orkestr requests only the scopes for the selected capabilities. Optional scopes that Google does not grant stay disabled. Drive uses selected-file access only.</p>
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
    .options { display: grid; gap: 10px; margin: 24px 0; }
    .field { display: grid; gap: 6px; margin: 24px 0 12px; }
    .field input { min-height: 42px; border: 1px solid #b8c1ca; border-radius: 6px; padding: 8px 10px; font: inherit; background: white; color: #172026; }
    .option { display: grid; grid-template-columns: 24px 1fr; gap: 4px 10px; align-items: start; padding: 14px; border: 1px solid #d3d8dc; border-radius: 8px; background: white; }
    .option input { margin-top: 3px; }
    .option span { grid-column: 2; color: #52606d; }
    .context { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 18px 0; }
    .context div { border: 1px solid #d3d8dc; border-radius: 8px; background: white; padding: 10px; }
    .context dt { color: #52606d; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .context dd { margin: 4px 0 0; overflow-wrap: anywhere; }
    .notice { color: #3f4d59; background: #e8f1ee; border: 1px solid #c6ded3; border-radius: 8px; padding: 12px; }
    .error { color: #842029; background: #f8d7da; border: 1px solid #f1aeb5; border-radius: 8px; padding: 12px; }
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
