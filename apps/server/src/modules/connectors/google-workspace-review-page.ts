function clean(value: unknown): string {
  return String(value || "").trim();
}

function escapeHtml(value: unknown): string {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function googleWorkspaceReviewLoginPageHtml({ error = "" }: { error?: string } = {}): string {
  const safeError = escapeHtml(error);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Orkestr reviewer environment</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172026; background: #f5f7f6; }
    body { margin: 0; } main { width: min(560px, calc(100% - 32px)); margin: 0 auto; padding: 72px 0; }
    h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; letter-spacing: 0; } p { line-height: 1.5; }
    .panel { background: #fff; border: 1px solid #d8dfdc; border-radius: 8px; padding: 22px; }
    .muted { color: #53605c; font-size: 14px; } .error { color: #9d2330; font-size: 14px; }
    form { display: grid; gap: 12px; margin-top: 20px; } label { display: grid; gap: 6px; color: #34413d; font-size: 14px; font-weight: 650; }
    input { box-sizing: border-box; border: 1px solid #aebbb5; border-radius: 5px; padding: 10px; background: #fff; color: #172026; font: inherit; }
    button { width: fit-content; border: 1px solid #1f684f; border-radius: 5px; padding: 10px 14px; background: #196f51; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <div class="panel">
      <h1>Orkestr reviewer environment</h1>
      <p class="muted">This is a dedicated, isolated Orkestr OSS instance for Google Workspace review. After sign-in, use the normal Orkestr Gmail connector to connect the supplied Google account and review the requested capabilities.</p>
      ${safeError ? `<p class="error">${safeError}</p>` : ""}
      <form method="post" action="/review/google/session">
        <label>Access password <input name="password" type="password" required autocomplete="current-password"></label>
        <button type="submit">Open Orkestr</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}
