export function googleWorkspaceReviewDemoPageHtml({ connected = false }: { connected?: boolean } = {}): string {
  const connectionNotice = connected
    ? `<div class="notice" role="status"><strong>Google Workspace connected.</strong> The approved capabilities are now available to this workspace. <a href="/review/google/actions">Review live Google actions</a></div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Orkestr client workspace review</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172026; background: #f5f7f6; }
    * { box-sizing: border-box; } body { margin: 0; } main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 56px; }
    h1 { font-size: 26px; line-height: 1.2; margin: 0; letter-spacing: 0; } h2 { font-size: 16px; margin: 0; letter-spacing: 0; } p { line-height: 1.5; }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 22px; border-bottom: 1px solid #d8dfdc; } .brand { font-weight: 850; color: #196f51; } .label { color: #53605c; font-size: 13px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; margin-top: 20px; } .panel { background: #fff; border: 1px solid #d8dfdc; border-radius: 8px; }
    .chat-head { padding: 18px 20px; border-bottom: 1px solid #e5e9e7; display: flex; justify-content: space-between; gap: 14px; align-items: center; } .status { color: #1d6b4f; font-size: 13px; font-weight: 750; }
    .messages { min-height: 390px; padding: 22px 20px; display: grid; gap: 16px; align-content: start; } .message { width: fit-content; max-width: min(88%, 640px); padding: 12px 14px; border-radius: 8px; line-height: 1.45; font-size: 14px; }
    .assistant { background: #eef5f1; border: 1px solid #d4e6dc; } .user { justify-self: end; background: #196f51; color: #fff; } .message a { color: inherit; font-weight: 800; } .assistant a { color: #155e45; }
    .composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 14px; border-top: 1px solid #e5e9e7; } input { width: 100%; min-width: 0; border: 1px solid #aebbb5; border-radius: 5px; padding: 10px; background: #fff; color: #172026; font: inherit; } button { border: 1px solid #1f684f; border-radius: 5px; padding: 10px 14px; background: #196f51; color: #fff; font: inherit; font-weight: 750; cursor: pointer; } button:disabled { opacity: .55; cursor: not-allowed; }
    .side { display: grid; gap: 18px; align-content: start; } .section { padding: 18px; } .section + .section { border-top: 1px solid #e5e9e7; } .timer { display: grid; gap: 5px; padding: 12px 0; border-bottom: 1px solid #e5e9e7; } .timer:last-child { border-bottom: 0; padding-bottom: 0; } .timer strong { font-size: 14px; } .muted { color: #53605c; font-size: 13px; margin: 5px 0 0; }
    .notice { margin-top: 18px; border: 1px solid #b9dcc9; background: #e9f6ed; color: #174f3b; padding: 12px 14px; border-radius: 6px; line-height: 1.45; font-size: 14px; } .notice a { color: #155e45; font-weight: 800; }
    @media (max-width: 800px) { main { width: min(100% - 24px, 1120px); padding-top: 18px; } .layout { grid-template-columns: 1fr; } .messages { min-height: 320px; } } @media (max-width: 500px) { .top { align-items: flex-start; flex-direction: column; } .composer { grid-template-columns: 1fr; } button { width: 100%; } }
  </style>
</head>
<body>
  <main>
    <header class="top"><div><div class="brand">Orkestr</div><h1>Client workspace review</h1></div><div class="label">Isolated Google Workspace review</div></header>
    ${connectionNotice}
    <div class="layout">
      <section class="panel">
        <div class="chat-head"><div><h2>Client operations</h2><div class="label">Persistent work thread</div></div><div class="status">Ready</div></div>
        <div class="messages" id="messages" aria-live="polite">
          <div class="message assistant">I can keep client work in this thread, prepare responses, and leave clear progress for the next person who opens it.</div>
          <div class="message assistant">Thread timers can run scheduled follow-up work. When an account owner connects Google Workspace, the approved Gmail and Calendar capabilities can be used directly in chat or by those timers.</div>
        </div>
        <form class="composer" id="chat-form"><input id="chat-message" aria-label="Message Client operations" autocomplete="off" placeholder="Ask Orkestr to create a Google connection link"><button id="send" type="submit">Send</button></form>
      </section>
      <aside class="panel side">
        <section class="section"><h2>Thread timers</h2><p class="muted">Examples of scheduled client follow-through.</p><div class="timer"><strong>Daily client brief</strong><span class="label">Weekdays at 09:00</span></div><div class="timer"><strong>Friday follow-up</strong><span class="label">Friday at 15:00</span></div></section>
        <section class="section"><h2>Google Workspace</h2><p class="muted">Optional, account-owner approved capabilities for Gmail and Calendar. Orkestr does not connect an account until the owner completes Google consent.</p></section>
      </aside>
    </div>
  </main>
  <script>
    const form = document.getElementById("chat-form");
    const input = document.getElementById("chat-message");
    const messages = document.getElementById("messages");
    const send = document.getElementById("send");
    function addMessage(kind, text, action) {
      const element = document.createElement("div");
      element.className = "message " + kind;
      const body = document.createElement("span");
      body.textContent = text;
      element.append(body);
      if (action && action.href && action.label) {
        element.append(document.createTextNode(" "));
        const link = document.createElement("a");
        link.href = action.href;
        link.textContent = action.label;
        element.append(link);
      }
      messages.append(element);
      messages.scrollTop = messages.scrollHeight;
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      addMessage("user", message);
      input.value = "";
      input.disabled = true;
      send.disabled = true;
      try {
        const response = await fetch("/review/google/demo/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || "request_failed");
        addMessage("assistant", payload.message || "", payload.action);
      } catch (error) {
        addMessage("assistant", "I could not prepare that request. Please try again.");
      } finally {
        input.disabled = false;
        send.disabled = false;
        input.focus();
      }
    });
  </script>
</body>
</html>`;
}
