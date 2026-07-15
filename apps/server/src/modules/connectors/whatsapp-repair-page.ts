function htmlEscape(value: unknown): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function whatsappRepairPageHtml(accountId = ""): string {
  const safeAccount = String(accountId || "sender").trim() || "sender";
  const accountJson = JSON.stringify(safeAccount);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp Repair</title>
  <style>
    :root { color-scheme: light dark; --bg: #f7f8f5; --text: #1d2522; --muted: #66706b; --line: #ccd6d0; --accent: #156f5b; --accent-strong: #0c4d42; --panel: #ffffff; --danger: #8b2f25; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111614; --text: #edf2ee; --muted: #9aa7a0; --line: #2f3b35; --accent: #68c8ad; --accent-strong: #8bdac3; --panel: #171f1c; --danger: #ff9a8f; } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(720px, calc(100vw - 32px)); margin: 0 auto; padding: 56px 0; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 28px; box-shadow: 0 18px 45px rgba(17, 24, 39, 0.08); }
    h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }
    p { margin: 0 0 18px; color: var(--muted); font-size: 15px; line-height: 1.55; }
    dl { display: grid; grid-template-columns: 120px 1fr; gap: 8px 14px; margin: 22px 0; padding: 16px; border: 1px solid var(--line); border-radius: 8px; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    button { min-height: 44px; border: 0; border-radius: 6px; padding: 0 18px; background: var(--accent); color: white; font-weight: 700; font-size: 15px; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--accent-strong); }
    button:disabled { opacity: 0.62; cursor: wait; }
    .status { margin-top: 18px; min-height: 24px; color: var(--muted); overflow-wrap: anywhere; }
    .status.error { color: var(--danger); }
    .footer { margin-top: 16px; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>WhatsApp Repair</h1>
      <p>This page stays open while Orkestr prepares a fresh pairing QR and emails it to the configured repair mailbox.</p>
      <dl>
        <dt>Account</dt>
        <dd>${htmlEscape(safeAccount)}</dd>
        <dt>Delivery</dt>
        <dd>Configured repair mailbox</dd>
      </dl>
      <button id="send" type="button">Email Fresh QR</button>
      <p id="status" class="status" aria-live="polite"></p>
      <p class="footer">Scan the QR from WhatsApp Linked Devices. Generate a new one if WhatsApp says the code expired.</p>
    </section>
  </main>
  <script>
    const accountId = ${accountJson};
    const button = document.getElementById("send");
    const status = document.getElementById("status");
    function setStatus(text, error) {
      status.textContent = text;
      status.className = error ? "status error" : "status";
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      setStatus("Generating QR and sending email...");
      try {
        const response = await fetch("/api/connectors/whatsapp/bridge/repair/send-email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId })
        });
        const raw = await response.text();
        let payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch {}
        if (!response.ok || payload.ok === false) throw new Error(payload.error || "qr_email_failed");
        if (payload.skippedReason === "already_ready") setStatus("WhatsApp is already paired for this account.");
        else if (payload.skippedReason === "cooldown") setStatus("A QR email was sent recently. Check the repair mailbox before requesting another one.");
        else setStatus("QR email sent to " + ((payload.recipients || []).join(", ") || "the configured repair mailbox") + ".");
      } catch (error) {
        setStatus(error && error.message ? error.message : "Could not send QR email.", true);
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
