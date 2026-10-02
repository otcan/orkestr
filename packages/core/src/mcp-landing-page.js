// What a browser sees at GET /mcp: the server address to paste into ChatGPT,
// how connecting works, and (when signed in) the assistants connected to this
// account with a revoke button. MCP clients never get this page.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function date(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

/** @param {{ resourceUrl: string, userId?: string, connections?: any[], subscriptions?: any[], notice?: string }} input */
export function mcpLandingPage({ resourceUrl, userId = "", connections = [], subscriptions = [], notice = "" }) {
  const rows = connections.map((connection) => {
    const live = subscriptions.filter((entry) => entry.agentId === connection.agentId).length;
    return `<tr><td>${escapeHtml(connection.clientName)}</td><td>${escapeHtml(date(connection.createdAt))}</td><td>${escapeHtml(date(connection.expiresAt))}</td>
<td>${live ? `${live} live event subscription${live === 1 ? "" : "s"}` : "no live events"}</td>
<td><form method="post" action="/mcp-oauth/connections/revoke"><input type="hidden" name="grant_id" value="${escapeHtml(connection.grantId)}"><button type="submit">Revoke</button></form></td></tr>`;
  }).join("");
  const account = userId
    ? `<h2>Connected assistants</h2>${rows
      ? `<table><tr><th>Assistant</th><th>Connected</th><th>Expires</th><th>Live events</th><th></th></tr>${rows}</table>`
      : "<p>No assistant is connected to your account yet.</p>"}`
    : `<p><a href="/auth/login?return=${encodeURIComponent("/mcp")}">Sign in</a> to see and revoke the assistants connected to your account.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orkestr MCP server</title>
<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{background:#f2f2f2;padding:.15rem .35rem;border-radius:4px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.4rem;border-bottom:1px solid #ddd}.notice{background:#eef7ee;padding:.6rem;border-radius:6px}</style></head>
<body><h1>Orkestr MCP server</h1>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<p>This address is for AI assistants, not for browsing. Add it as an MCP server (for example as a ChatGPT plugin):</p>
<p><code>${escapeHtml(resourceUrl)}</code></p>
<ol><li>Choose OAuth sign-in; the assistant finds everything else itself.</li>
<li>Sign in with your Orkestr login and approve the access on the next page.</li>
<li>Ask the assistant about your threads, or to tell you when something new happens.</li></ol>
<p>Connected assistants can read the visible messages of all your threads, add comments labelled as theirs (never sent to WhatsApp, never starting work), and receive live notifications of new messages.</p>
${account}
</body></html>`;
}
