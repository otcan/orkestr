import {
  escapeHtml,
  publicAppUrl,
  publicCanonicalUrl,
  publicRepoUrl,
  type PublicPage,
  type PublicPageId,
} from "./public-site-config.js";

function navLink(path: string, label: string, current: PublicPageId, id: PublicPageId, event: string) {
  return `<a href="${path}"${current === id ? ' aria-current="page"' : ""} data-event="${event}">${label}</a>`;
}

function analyticsScript(home = false) {
  return `<script>
    (() => {
      const send = (event) => {
        if (!/^[a-z0-9_]{2,64}$/.test(event || "")) return;
        const body = JSON.stringify({ event, path: location.pathname });
        if (navigator.sendBeacon) navigator.sendBeacon("/api/public/events", new Blob([body], { type: "application/json" }));
        else fetch("/api/public/events", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
      };
      window.orkestrTrack = send;
      document.addEventListener("click", (event) => {
        const target = event.target && event.target.closest ? event.target.closest("[data-event]") : null;
        if (target) send(target.getAttribute("data-event"));
      });
      const observed = document.querySelectorAll("[data-view-event]");
      if (observed.length && "IntersectionObserver" in window) {
        const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          send(entry.target.getAttribute("data-view-event")); observer.unobserve(entry.target);
        }), { threshold: .35 });
        observed.forEach((element) => observer.observe(element));
      }
      ${home ? 'if (location.hash === "#waitlist") location.replace("/beta#waitlist");' : ""}
    })();
  </script>`;
}

export function renderPublicShell(page: PublicPage, env = process.env) {
  const home = page.id === "home";
  const pageTitle = home ? "AI Operations Layer | Orkestr" : `${page.title} | Orkestr`;
  const canonical = publicCanonicalUrl(page.canonicalPath || (home ? "/" : `/${page.id}`), env);
  const appUrl = publicAppUrl(env);
  const repo = publicRepoUrl(env);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(page.summary)}">
  <meta name="application-name" content="Orkestr">
  <meta name="theme-color" content="#f2efe6">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Orkestr">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(page.summary)}">
  ${canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}"><link rel="canonical" href="${escapeHtml(canonical)}">` : ""}
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/public-site.css">
</head>
<body class="page-${page.id}">
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="topbar">
    <a class="wordmark" href="/" aria-label="Orkestr home"><span>O</span> Orkestr</a>
    <nav class="desktop-nav" aria-label="Primary navigation">
      ${navLink("/use-cases", "Use cases", page.id, "use-cases", "nav_use_cases")}
      ${navLink("/deployment", "Deployment", page.id, "deployment", "nav_deployment")}
      ${navLink("/security", "Security", page.id, "security", "nav_security")}
      ${navLink("/developers", "Developers", page.id, "developers", "nav_developers")}
    </nav>
    <div class="header-actions">
      <a class="text-action" href="${escapeHtml(appUrl)}" data-event="sign_in_click">Sign in</a>
      <a class="button button-small" href="/workflow" data-event="map_workflow_header">Map one workflow</a>
    </div>
    <details class="mobile-menu">
      <summary aria-label="Open navigation">Menu</summary>
      <nav aria-label="Mobile navigation">
        <a href="/use-cases">Use cases</a><a href="/deployment">Deployment</a><a href="/security">Security</a><a href="/developers">Developers</a><a href="${escapeHtml(appUrl)}">Sign in</a>
      </nav>
    </details>
  </header>
  ${page.body}
  <footer class="footer">
    <div class="footer-brand"><a class="wordmark inverse" href="/"><span>O</span> Orkestr</a><p>AI operations, under human control.</p></div>
    <nav aria-label="Product links"><strong>Evaluate</strong><a href="/use-cases">Use cases</a><a href="/security">Security</a><a href="/deployment">Deployment</a><a href="/workflow">Workflow Pilot</a></nav>
    <nav aria-label="Technical links"><strong>Build</strong><a href="/developers">Developers</a><a href="${escapeHtml(repo)}" rel="noreferrer">GitHub</a><a href="/beta">Personal beta</a><a href="/support">Support</a></nav>
    <nav aria-label="Legal links"><strong>Legal</strong><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/acceptable-use">Acceptable use</a><a href="/data-deletion">Data deletion</a></nav>
    <p class="footer-note">Managed private deployment. Public-alpha OSS core. Capabilities vary by deployment.</p>
  </footer>
  ${analyticsScript(home)}
</body>
</html>`;
}
