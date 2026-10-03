// The page a desktop share link opens (served by static-fallback.ts). Its
// owner opens it with their Orkestr session in one click; other recipients
// approve the browser's one-time challenge from the chat.
import { escapeHtml } from "./browser-page-security.js";
export function serveDesktopSharePage(response: any, appUrl = "") {
  let appOrigin = "";
  try { appOrigin = appUrl ? new URL(appUrl).origin : ""; } catch { appOrigin = ""; }
  return response
    .status(200)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Orkestr Desktop Access</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101418; color: #f6f8fb; }
    main { width: min(92vw, 520px); padding: 28px; border: 1px solid #2d3743; background: #171d24; border-radius: 8px; box-shadow: 0 18px 60px #0008; }
    h1 { margin: 0 0 10px; font-size: 24px; letter-spacing: 0; }
    p { margin: 10px 0; color: #c8d0db; line-height: 1.45; }
    code { display: block; margin: 18px 0; padding: 16px; border-radius: 6px; background: #0b0f14; color: #9be7c1; font-size: 17px; overflow-wrap: anywhere; user-select: all; }
    button, a.button { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 0 16px; border-radius: 6px; border: 1px solid #5b6b7d; background: #e8edf3; color: #111820; font-weight: 700; text-decoration: none; }
    small { display: block; margin-top: 16px; color: #8f9baa; }
    .error { color: #ffb4a9; }
    #viewer { position: fixed; inset: 0; background: #050708; }
    #viewer iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
  <main id="share-panel" data-app-origin="${escapeHtml(appOrigin)}">
    <h1>Orkestr Desktop Access</h1>
    <p id="summary">Opening the desktop…</p>
    <a id="owner" class="button" href="#" hidden>Open with my Orkestr login</a>
    <p id="status"></p>
    <a id="open" class="button" href="#" hidden>Open desktop</a>
    <a id="mobile" class="button" href="#" hidden>Mobile controls</a>
    <details id="chat-approval">
      <summary>Not the owner? Approve from chat instead</summary>
      <p>Paste this exact command into the Orkestr chat that sent the link:</p>
      <code id="challenge">loading</code>
      <button id="copy" type="button">Copy command</button>
    </details>
    <small id="lifecycle" aria-live="polite"></small>
  </main>
  <section id="viewer" hidden><iframe id="desktop-frame" title="Orkestr desktop"></iframe></section>
  <script>
    const parts = location.pathname.split('/').filter(Boolean);
    const shareIndex = parts.indexOf('desktop-share');
    const shareParts = shareIndex >= 0 ? parts.slice(shareIndex) : parts;
    const tenantShare = shareParts[0] === 'desktop-share' && shareParts[1] === 'tvm';
    const tenantVmId = tenantShare ? decodeURIComponent(shareParts[2] || '') : '';
    const subdomain = tenantShare ? decodeURIComponent(shareParts[3] || '') : (shareParts.length > 2 ? shareParts[1] : '');
    const shareId = tenantShare ? decodeURIComponent(shareParts[4] || '') : (shareParts[shareParts.length - 1] || '');
    const key = new URLSearchParams(location.search).get('key') || '';
    const sharePanel = document.getElementById('share-panel');
    const appOrigin = (sharePanel && sharePanel.dataset && sharePanel.dataset.appOrigin) || '';
    const owner = document.getElementById('owner');
    const chatApproval = document.getElementById('chat-approval');
    const challenge = document.getElementById('challenge');
    const statusNode = document.getElementById('status');
    const lifecycleNode = document.getElementById('lifecycle');
    const summary = document.getElementById('summary');
    const open = document.getElementById('open');
    const mobile = document.getElementById('mobile');
    const copy = document.getElementById('copy');
    const main = document.getElementById('share-panel');
    const viewer = document.getElementById('viewer');
    const desktopFrame = document.getElementById('desktop-frame');
    const api = (action) => {
      const base = tenantVmId
        ? '/api/tenant-vms/' + encodeURIComponent(tenantVmId) + '/desktop-shares/' + encodeURIComponent(shareId) + '/' + action
        : '/api/desktop-shares/' + encodeURIComponent(shareId) + '/' + action;
      return base + '?key=' + encodeURIComponent(key) + (subdomain ? '&subdomain=' + encodeURIComponent(subdomain) : '');
    };
    function mobileDestination(value) {
      const parsed = new URL(value, location.origin);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'desktop' && parts[1] && parts[2] === 'vnc.html') {
        return '/desktop/' + encodeURIComponent(decodeURIComponent(parts[1])) + '/mobile';
      }
      if (parts[0] === 'tenant-vms' && parts[1] && parts[2] === 'desktop' && parts[3] && parts[4] === 'vnc.html') {
        return '/tenant-vms/' + encodeURIComponent(decodeURIComponent(parts[1])) + '/desktop/' + encodeURIComponent(decodeURIComponent(parts[3])) + '/mobile';
      }
      return value;
    }
    async function json(url) {
      const response = await fetch(url, { credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        const error = new Error(body.renewal && body.renewal.message ? body.renewal.message : (body.error || body.message || 'desktop_share_failed'));
        error.payload = body;
        throw error;
      }
      return body;
    }
    function showExpired(error) {
      const renewal = error && error.payload ? error.payload.renewal : null;
      if (!renewal || !renewal.renewCommand) return false;
      hideDesktop();
      challenge.textContent = renewal.renewCommand;
      summary.textContent = 'This desktop link expired.';
      statusNode.textContent = renewal.message || 'Ask the Orkestr operator to create a fresh desktop link.';
      statusNode.className = 'error';
      copy.textContent = 'Copy renewal command';
      chatApproval.open = true;
      return true;
    }
    function hideDesktop() {
      viewer.hidden = true;
      desktopFrame.removeAttribute('src');
      main.hidden = false;
      open.hidden = true;
      open.removeAttribute('href');
      mobile.hidden = true;
      mobile.removeAttribute('href');
    }
    function showTerminal(error) {
      const lifecycle = error && error.payload ? error.payload.lifecycle : null;
      if (!lifecycle || !['superseded', 'revoked'].includes(lifecycle.status)) return false;
      hideDesktop();
      challenge.textContent = lifecycle.status === 'superseded' ? 'replaced' : 'revoked';
      summary.textContent = lifecycle.status === 'superseded' ? 'This desktop share was replaced.' : 'This desktop share was revoked.';
      statusNode.textContent = 'Return to the Orkestr chat and request a new desktop link.';
      statusNode.className = 'error';
      copy.hidden = true;
      return true;
    }
    function showDesktop(desktopUrl) {
      const target = new URL(desktopUrl, location.origin);
      if (target.origin !== location.origin) throw new Error('desktop_share_origin_mismatch');
      location.replace(target.href);
    }
    function lifecycleTime(value) {
      if (!value) return 'unknown';
      const time = new Date(value);
      return Number.isNaN(time.getTime()) ? 'unknown' : time.toLocaleString();
    }
    function renderLifecycle(body) {
      const share = body && body.share ? body.share : {};
      const attempt = body && body.attempt ? body.attempt : {};
      const generation = Number(share.shareGeneration || 0);
      const shareStatus = share.status || 'pending';
      const attemptStatus = attempt.status || 'not opened';
      const approved = attempt.approvedAt ? ' approved ' + lifecycleTime(attempt.approvedAt) : '';
      lifecycleNode.textContent = 'Generation ' + generation + ' · ' + shareStatus + ' · attempt ' + attemptStatus + approved + ' · expires ' + lifecycleTime(share.expiresAt);
    }
    async function poll() {
      try {
        const body = await json(api('status'));
        renderLifecycle(body);
        if (body.approved && body.desktopUrl) {
          const desktopUrl = body.desktopUrl;
          statusNode.textContent = 'Approved. Desktop connected.';
          open.href = desktopUrl;
          open.hidden = false;
          const mobileUrl = mobileDestination(body.desktopUrl);
          if (mobileUrl !== desktopUrl) {
            mobile.href = mobileUrl;
            mobile.hidden = false;
          }
          showDesktop(desktopUrl);
        }
        if (!body.approved && owner.hidden) statusNode.textContent = 'Waiting for approval.';
        setTimeout(poll, 2000);
      } catch (error) {
        if (showExpired(error)) return;
        if (showTerminal(error)) return;
        statusNode.textContent = error.message || String(error);
        statusNode.className = 'error';
      }
    }
    // The signed-in owner opens their own link with one click: their Orkestr
    // session approves this browser's attempt (no challenge to copy). On
    // another host the session is not available, so offer the same link on
    // the Orkestr app host; signed-out owners are sent through sign-in.
    async function approveAsOwner() {
      if (tenantVmId) return;
      const here = location.pathname + location.search;
      if (appOrigin && location.origin !== appOrigin) {
        owner.href = appOrigin + here;
        owner.hidden = false;
        summary.textContent = 'Open this desktop with your Orkestr login.';
        return;
      }
      const response = await fetch(api('approve-as-owner'), { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } }).catch(() => null);
      if (response && response.ok) {
        summary.textContent = 'Opening the desktop…';
        return;
      }
      if (response && response.status === 401) {
        owner.textContent = 'Sign in to open';
        owner.href = '/auth/login?return=' + encodeURIComponent(here);
        owner.hidden = false;
        summary.textContent = 'Sign in to Orkestr to open this desktop.';
        return;
      }
      summary.textContent = 'This desktop link needs approval from the Orkestr chat.';
      chatApproval.open = true;
    }
    async function start() {
      try {
        const body = await json(api('open'));
        renderLifecycle(body);
        const value = body.attempt && body.attempt.challenge ? body.attempt.challenge : '';
        challenge.textContent = 'orkestr desktop approve ' + value;
        if (!body.approved) await approveAsOwner();
        poll();
      } catch (error) {
        if (showExpired(error)) return;
        if (showTerminal(error)) return;
        challenge.textContent = 'not available';
        statusNode.textContent = error.message || String(error);
        statusNode.className = 'error';
      }
    }
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(challenge.textContent || '');
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy command'; }, 1200);
    });
    start();
  </script>
</body>
</html>`);
}
