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
  <title>Google Workspace review | Orkestr</title>
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
      <h1>Google Workspace review</h1>
      <p class="muted">This is an isolated Orkestr environment for reviewing the Google permissions requested by this app.</p>
      ${safeError ? `<p class="error">${safeError}</p>` : ""}
      <form method="post" action="/review/google/session">
        <label>Review password <input name="password" type="password" required autocomplete="current-password"></label>
        <button type="submit">Continue</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

export function googleWorkspaceReviewPageHtml({ ticket = "", expiresAt = "" }: { ticket?: string; expiresAt?: string } = {}): string {
  const encodedTicket = encodeURIComponent(clean(ticket));
  const safeExpiresAt = escapeHtml(expiresAt);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Google Workspace review | Orkestr</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172026; background: #f5f7f6; }
    body { margin: 0; }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    header { display: flex; align-items: start; justify-content: space-between; gap: 24px; border-bottom: 1px solid #d8dfdc; padding-bottom: 20px; margin-bottom: 24px; }
    h1 { font-size: 28px; line-height: 1.2; margin: 0; font-weight: 750; letter-spacing: 0; }
    h2 { font-size: 17px; margin: 0 0 14px; letter-spacing: 0; }
    p { line-height: 1.5; }
    .muted { color: #53605c; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .panel { background: #fff; border: 1px solid #d8dfdc; border-radius: 8px; padding: 18px; }
    .wide { grid-column: 1 / -1; }
    .status { min-height: 42px; white-space: pre-wrap; color: #34413d; }
    .notice { border-left: 3px solid #1d7a5b; padding-left: 12px; margin: 0; }
    .error { color: #9d2330; }
    form { display: grid; gap: 10px; }
    label { display: grid; gap: 5px; color: #34413d; font-size: 14px; font-weight: 650; }
    input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid #aebbb5; border-radius: 5px; padding: 9px 10px; background: #fff; color: #172026; font: inherit; }
    textarea { min-height: 90px; resize: vertical; }
    button { width: fit-content; border: 1px solid #1f684f; border-radius: 5px; padding: 9px 13px; background: #196f51; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    button.secondary { border-color: #8c9b95; background: #fff; color: #25312d; }
    button:disabled { opacity: .6; cursor: progress; }
    .rows { display: grid; gap: 8px; }
    .row { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid #e2e7e4; padding-top: 8px; font-size: 14px; }
    .row:first-child { border-top: 0; padding-top: 0; }
    .confirm { display: flex; align-items: center; gap: 8px; font-weight: 500; }
    .confirm input { width: auto; }
    @media (max-width: 760px) { main { width: min(100% - 24px, 680px); padding-top: 18px; } header { display: block; } .grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Google Workspace review</h1>
        <p class="muted">An isolated Orkestr review environment for the Google permissions requested by this app.</p>
      </div>
      <p class="muted">Review link expires: ${safeExpiresAt || "soon"}</p>
    </header>
    <section class="panel wide">
      <p class="notice">This environment is limited to the reviewer account and Google Workspace operations below. It cannot access production threads, WhatsApp, browser profiles, or unrelated Orkestr data.</p>
      <div id="status" class="status">Checking connection status...</div>
      <button id="connect" type="button">Connect Google</button>
    </section>
    <section class="grid" aria-live="polite">
      <section class="panel">
        <h2>Review tasks</h2>
        <ol class="muted">
          <li>Connect the synthetic reviewer account and select the requested Gmail and Calendar permissions.</li>
          <li>Read one synthetic Gmail message, prepare a draft, and send an explicitly approved test message.</li>
          <li>List upcoming synthetic Calendar events and create one explicitly approved test event.</li>
        </ol>
      </section>
      <section class="panel">
        <h2>Action log</h2>
        <div id="action-log" class="rows muted">No review actions yet.</div>
      </section>
      <section class="panel">
        <h2>Read Gmail</h2>
        <form id="gmail-read">
          <label>Search query <input name="query" placeholder="newer_than:7d" autocomplete="off"></label>
          <label>Account <select name="connectionId"><option value="">Default account</option></select></label>
          <button type="submit" class="secondary">List messages</button>
        </form>
        <div id="messages" class="rows muted">Connect Google, then search messages.</div>
        <form id="gmail-message">
          <label>Message ID <input name="messageId" required autocomplete="off"></label>
          <label>Account <select name="connectionId"><option value="">Default account</option></select></label>
          <button type="submit" class="secondary">Read message</button>
        </form>
        <div id="message-result" class="rows muted"></div>
      </section>
      <section class="panel">
        <h2>Prepare Gmail draft</h2>
        <form id="draft">
          <label>To <input name="to" type="email" required></label>
          <label>Subject <input name="subject" required></label>
          <label>Body <textarea name="body" required></textarea></label>
          <label>Account <select name="connectionId"><option value="">Default account</option></select></label>
          <button type="submit">Create draft</button>
        </form>
        <div id="draft-result" class="muted"></div>
      </section>
      <section class="panel">
        <h2>Send Gmail message</h2>
        <form id="send">
          <label>To <input name="to" type="email" required></label>
          <label>Subject <input name="subject" required></label>
          <label>Body <textarea name="body" required></textarea></label>
          <label>Account <select name="connectionId"><option value="">Default account</option></select></label>
          <label class="confirm"><input name="confirmed" type="checkbox" required> I approve sending this message.</label>
          <button type="submit">Send message</button>
        </form>
        <div id="send-result" class="muted"></div>
      </section>
      <section class="panel">
        <h2>Read Calendar</h2>
        <form id="calendar-read">
          <label>From <input name="timeMin" type="datetime-local" required></label>
          <label>Until <input name="timeMax" type="datetime-local" required></label>
          <label>Account <select name="connectionId"><option value="">Default account</option></select></label>
          <button type="submit" class="secondary">List events</button>
        </form>
        <div id="events" class="rows muted">Choose a range after connecting Google.</div>
      </section>
      <section class="panel">
        <h2>Create Calendar event</h2>
        <form id="calendar-create">
          <label>Summary <input name="summary" required></label>
          <label>Start <input name="startDateTime" type="datetime-local" required></label>
          <label>End <input name="endDateTime" type="datetime-local" required></label>
          <label>Description <textarea name="description"></textarea></label>
          <label>Account <select name="connectionId"><option value="">Default account</option></select></label>
          <label class="confirm"><input name="confirmed" type="checkbox" required> I approve creating this event.</label>
          <button type="submit">Create event</button>
        </form>
        <div id="event-result" class="muted"></div>
      </section>
    </section>
  </main>
  <script>
    const base = '/review/google/${encodedTicket}';
    const status = document.getElementById('status');
    const actionLog = document.getElementById('action-log');
    const selects = [...document.querySelectorAll('select[name="connectionId"]')];
    const output = (element, value, error = false) => { element.textContent = value; element.className = error ? 'error' : 'muted'; };
    const asJson = async (response) => { const body = await response.json().catch(() => ({})); if (!response.ok || body.ok === false) throw new Error(body.error || body.message || 'Request failed'); return body; };
    const values = (form) => Object.fromEntries(new FormData(form).entries());
    const iso = (value) => value ? new Date(value).toISOString() : '';
    const text = (value) => String(value || '');
    const actionLabel = (value) => text(value).replaceAll('_', ' ');
    const refreshStatus = async () => {
      try {
        const payload = await asJson(await fetch(base + '/status', { cache: 'no-store' }));
        const connections = payload.connections || [];
        status.textContent = connections.length ? 'Google is ' + (payload.connectionState || 'connected') + ': ' + connections.map((connection) => connection.email || connection.alias || connection.connectionId).join(', ') : 'Google is not connected yet.';
        for (const select of selects) {
          const current = select.value;
          select.replaceChildren(new Option('Default account', ''));
          for (const connection of connections) select.append(new Option(connection.email || connection.alias || connection.connectionId, connection.connectionId));
          select.value = current;
        }
        const actions = payload.actions || [];
        output(actionLog, actions.length ? actions.map((action) => (action.at || '') + '  ' + actionLabel(action.action)).join('\n') : 'No review actions yet.');
      } catch (error) { output(status, error.message, true); }
    };
    const post = async (path, body) => asJson(await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    document.getElementById('connect').addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      output(status, 'Google is connecting...');
      try { window.location.assign((await post('/connect', {})).connectUrl); } catch (error) { output(status, error.message, true); event.currentTarget.disabled = false; }
    });
    document.getElementById('gmail-read').addEventListener('submit', async (event) => {
      event.preventDefault(); const form = event.currentTarget; const query = new URLSearchParams(values(form));
      try { const payload = await asJson(await fetch(base + '/gmail/messages?' + query, { cache: 'no-store' })); const items = payload.messages || []; output(document.getElementById('messages'), items.length ? items.map((message) => message.id).join('\n') : 'No matching messages.'); } catch (error) { output(document.getElementById('messages'), error.message, true); }
    });
    document.getElementById('gmail-message').addEventListener('submit', async (event) => {
      event.preventDefault(); const data = values(event.currentTarget);
      try { const payload = await asJson(await fetch(base + '/gmail/messages/' + encodeURIComponent(data.messageId) + '?connectionId=' + encodeURIComponent(data.connectionId || ''), { cache: 'no-store' })); const message = payload.message || {}; output(document.getElementById('message-result'), [message.from, message.subject, message.date, message.body].filter(Boolean).join('\n\n') || 'Message is empty.'); } catch (error) { output(document.getElementById('message-result'), error.message, true); }
    });
    document.getElementById('draft').addEventListener('submit', async (event) => {
      event.preventDefault(); try { const payload = await post('/gmail/drafts', values(event.currentTarget)); output(document.getElementById('draft-result'), 'Draft created: ' + (payload.draft?.id || 'ready')); } catch (error) { output(document.getElementById('draft-result'), error.message, true); }
    });
    document.getElementById('send').addEventListener('submit', async (event) => {
      event.preventDefault(); const data = values(event.currentTarget); data.confirmed = data.confirmed === 'on';
      try { const payload = await post('/gmail/messages', data); output(document.getElementById('send-result'), 'Message sent: ' + (payload.message?.id || 'ready')); } catch (error) { output(document.getElementById('send-result'), error.message, true); }
    });
    document.getElementById('calendar-read').addEventListener('submit', async (event) => {
      event.preventDefault(); const data = values(event.currentTarget); data.timeMin = iso(data.timeMin); data.timeMax = iso(data.timeMax);
      try { const payload = await asJson(await fetch(base + '/calendar/events?' + new URLSearchParams(data), { cache: 'no-store' })); const items = payload.events || []; output(document.getElementById('events'), items.length ? items.map((item) => item.summary || item.id).join('\n') : 'No events in this range.'); } catch (error) { output(document.getElementById('events'), error.message, true); }
    });
    document.getElementById('calendar-create').addEventListener('submit', async (event) => {
      event.preventDefault(); const data = values(event.currentTarget); data.startDateTime = iso(data.startDateTime); data.endDateTime = iso(data.endDateTime); data.confirmed = data.confirmed === 'on';
      try { const payload = await post('/calendar/events', data); output(document.getElementById('event-result'), 'Event created: ' + (payload.event?.summary || payload.event?.id || 'ready')); } catch (error) { output(document.getElementById('event-result'), error.message, true); }
    });
    refreshStatus();
  </script>
</body>
</html>`;
}
