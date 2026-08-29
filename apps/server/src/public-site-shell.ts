import {
  escapeHtml,
  publicAppUrl,
  publicCanonicalUrl,
  publicRepoUrl,
  publicSiteBaseUrl,
  normalizePublicUrl,
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

function structuredData(page: PublicPage, env = process.env) {
  const base = publicSiteBaseUrl(env);
  if (!base) return "";
  const canonical = publicCanonicalUrl(page.canonicalPath || (page.id === "home" ? "/" : `/${page.id}`), env);
  const repo = normalizePublicUrl(publicRepoUrl(env));
  const graph: Array<Record<string, unknown>> = [
    {
      "@type": "Organization",
      "@id": `${base}/#organization`,
      name: "Orkestr",
      url: `${base}/`,
      ...(repo ? { sameAs: [repo] } : {}),
    },
    {
      "@type": "WebSite",
      "@id": `${base}/#website`,
      name: "Orkestr",
      url: `${base}/`,
      publisher: { "@id": `${base}/#organization` },
    },
  ];
  if (page.id !== "home" && canonical) {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${base}/` },
        { "@type": "ListItem", position: 2, name: page.title, item: canonical },
      ],
    });
  }
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

export function renderPublicShell(page: PublicPage, env = process.env) {
  const home = page.id === "home";
  const pageTitle = `${page.title} | Orkestr`;
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
  <meta name="robots" content="index,follow,max-image-preview:large">
  <meta name="theme-color" content="#f2efe6">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Orkestr">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(page.summary)}">
  ${canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}"><link rel="canonical" href="${escapeHtml(canonical)}">` : ""}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(page.summary)}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/public-site.css">
  ${structuredData(page, env)}
</head>
<body class="page-${page.id}">
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="topbar">
    <a class="wordmark" href="/" aria-label="Orkestr home"><span>O</span> Orkestr</a>
    <nav class="desktop-nav" aria-label="Primary navigation">
      ${navLink("/use-cases", "What we build", page.id, "use-cases", "nav_what_we_build")}
      <a href="/#examples" data-event="nav_examples">Examples</a>
      <a href="/#how-we-work" data-event="nav_how_we_work">How we work</a>
      ${navLink("/security", "Security", page.id, "security", "nav_security")}
    </nav>
    <div class="header-actions">
      <a class="button button-small" href="/project#book" data-event="book_project_header">Book a project call</a>
    </div>
    <details class="mobile-menu">
      <summary aria-label="Open navigation">Menu</summary>
      <nav aria-label="Mobile navigation">
        <a href="/use-cases">What we build</a><a href="/#examples">Examples</a><a href="/#how-we-work">How we work</a><a href="/security">Security</a><a href="/project#book" data-event="book_project_mobile">Book a project call</a>
      </nav>
    </details>
  </header>
  ${page.body}
  <footer class="footer">
    <div class="footer-brand"><a class="wordmark inverse" href="/"><span>O</span> Orkestr</a><p>We design, build, modernize, and operate systems for real business work.</p></div>
    <nav aria-label="Solution links"><strong>What we build</strong><a href="/websites-commerce">New systems</a><a href="/business-systems">System modernization</a><a href="/automation">Work &amp; data automation</a></nav>
    <nav aria-label="Orkestr links"><strong>Orkestr</strong><a href="/#how-we-work">How we work</a><a href="/#platform">Operating layer</a><a href="/deployment">Deployment</a><a href="/security">Security</a></nav>
    <nav aria-label="Resource links"><strong>Resources</strong><a href="/developers">Developers</a><a href="${escapeHtml(repo)}" rel="noreferrer">GitHub</a><a href="${escapeHtml(repo)}/tree/main/docs" rel="noreferrer">Documentation</a></nav>
    <nav aria-label="Company links"><strong>Company</strong><a href="/support">Contact</a><a href="/impressum">Impressum</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
    <nav aria-label="Customer links"><strong>Existing customers</strong><a href="${escapeHtml(appUrl)}" data-event="client_portal_click">Client Portal</a></nav>
    <p class="footer-note">Managed implementations. Open-source operating core. Scope, deployment, access, and support vary by project.</p>
  </footer>
  ${analyticsScript(home)}
</body>
</html>`;
}
