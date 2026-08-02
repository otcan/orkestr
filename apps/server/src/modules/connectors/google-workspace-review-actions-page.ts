export function googleWorkspaceReviewActionsPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Orkestr Google Workspace review</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172026; background: #f5f7f6; }
    body { margin: 0; } main { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }
    h1 { font-size: 30px; line-height: 1.2; margin: 0 0 8px; letter-spacing: 0; } h2 { font-size: 17px; margin: 0 0 8px; letter-spacing: 0; }
    p { line-height: 1.5; } .muted { color: #53605c; font-size: 14px; } .eyebrow { color: #196f51; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; }
    .panel, .task { background: #fff; border: 1px solid #d8dfdc; border-radius: 8px; } .panel { padding: 22px; margin-top: 22px; }
    .task-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; margin-top: 16px; } .task { padding: 16px; display: grid; gap: 10px; }
    button, .button { width: fit-content; border: 1px solid #1f684f; border-radius: 5px; padding: 9px 12px; background: #196f51; color: #fff; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; }
    .button.secondary { background: #fff; color: #196f51; } button:disabled { cursor: not-allowed; opacity: 0.5; }
    .connection { display: flex; align-items: center; justify-content: space-between; gap: 16px; } .badge { border-radius: 999px; padding: 5px 9px; font-size: 12px; font-weight: 800; background: #e3f4e9; color: #135b42; white-space: nowrap; } .badge.pending { background: #fff3d6; color: #7d5100; }
    pre { overflow: auto; max-height: 360px; margin: 16px 0 0; border-radius: 6px; padding: 14px; background: #102019; color: #d7f4df; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
    ul { margin: 8px 0 0; padding-left: 20px; } li { margin: 5px 0; } @media (max-width: 600px) { main { width: min(100% - 24px, 920px); padding-top: 24px; } .connection { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">ORKESTR REVIEW ENVIRONMENT</div>
    <h1>Google Workspace capabilities</h1>
    <p class="muted">This isolated environment performs real Gmail and Google Calendar operations only for the Google account you connect. Test messages are addressed to that same account and test calendar events have no guests.</p>
    <p><a class="button secondary" href="/review/google/demo">Back to Orkestr workspace</a></p>

    <section class="panel connection">
      <div><h2 id="account-title">Checking Google connection</h2><p class="muted" id="account-detail">Connect a Google account to enable the review actions.</p></div>
      <a class="button secondary" href="/connectors/gmail">Connect or manage Google</a>
    </section>

    <section class="panel">
      <h2>Requested capabilities</h2>
      <ul>
        <li>Gmail read: inspect the self-addressed review test message.</li>
        <li>Gmail drafts: create a draft addressed to the connected account.</li>
        <li>Gmail send: send a test message to the connected account.</li>
        <li>Calendar read: list reviewer-created test events.</li>
        <li>Calendar actions: create a test event on the connected account's primary calendar.</li>
      </ul>
      <div class="task-grid">
        <article class="task"><h2>Read Gmail</h2><p class="muted">Loads the test message sent by this reviewer environment.</p><button data-action="gmail-read">Read test message</button></article>
        <article class="task"><h2>Create draft</h2><p class="muted">Creates a review draft addressed to the connected account.</p><button data-action="gmail-draft">Create test draft</button></article>
        <article class="task"><h2>Send Gmail</h2><p class="muted">Sends a review message only to the connected account.</p><button data-action="gmail-send">Send test message</button></article>
        <article class="task"><h2>Read Calendar</h2><p class="muted">Lists up to five reviewer-created test events from the primary calendar.</p><button data-action="calendar-list">List test events</button></article>
        <article class="task"><h2>Create event</h2><p class="muted">Creates a no-guest review event in the primary calendar.</p><button data-action="calendar-create">Create test event</button></article>
      </div>
      <pre id="result" aria-live="polite">Select an action to show its real connector result.</pre>
    </section>
  </main>
  <script>
    const result = document.getElementById("result");
    const accountTitle = document.getElementById("account-title");
    const accountDetail = document.getElementById("account-detail");
    const buttons = [...document.querySelectorAll("button[data-action]")];
    let connected = false;

    function show(value) { result.textContent = JSON.stringify(value, null, 2); }
    function update(status, showAudit = true) {
      connected = Boolean(status.connected);
      accountTitle.textContent = connected ? "Connected: " + status.account.email : "Google account not connected";
      accountDetail.textContent = connected
        ? "Enabled: " + (status.account.capabilities || []).join(", ") + "."
        : "Use Connect or manage Google, then return here after Google consent.";
      buttons.forEach((button) => { button.disabled = !connected; });
      if (showAudit && status.audit?.length) show({ connection: status.account, recentActions: status.audit });
    }
    async function request(path, options) {
      const response = await fetch(path, options);
      const payload = await response.json().catch(() => ({ ok: false, error: "invalid_response" }));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || payload.message || "request_failed_" + response.status);
      return payload;
    }
    async function loadStatus(showAudit = true) {
      try { update(await request("/review/google/actions/api/status"), showAudit); }
      catch (error) { show({ ok: false, error: String(error.message || error) }); }
    }
    buttons.forEach((button) => button.addEventListener("click", async () => {
      if (!connected) return;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = "Working...";
      try {
        const action = button.dataset.action;
        const payload = await request("/review/google/actions/api/" + action, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        show(payload);
        await loadStatus(false);
      } catch (error) { show({ ok: false, error: String(error.message || error) }); }
      finally { button.textContent = label; button.disabled = !connected; }
    }));
    loadStatus();
  </script>
</body>
</html>`;
}
