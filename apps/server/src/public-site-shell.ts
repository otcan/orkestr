import {
  escapeHtml,
  publicAppUrl,
  publicCanonicalUrl,
  publicLocaleOpenGraphTags,
  publicLocales,
  publicLocaleTags,
  publicPagePath,
  publicRepoUrl,
  publicSiteBaseUrl,
  normalizePublicUrl,
  type PublicLocale,
  type PublicPage,
  type PublicPageId,
} from "./public-site-config.js";

const shellCopy: Record<PublicLocale, Record<string, string>> = {
  en: {
    skip: "Skip to content", home: "Orkestr home", primary: "Primary navigation", menu: "Menu",
    build: "What we build", examples: "Examples", process: "How we work", security: "Security", book: "Book a project call",
    footer: "We design, build, modernize, and operate systems for real business work.", solutions: "What we build",
    newSystems: "New systems", modernization: "System modernization", automation: "Work & data automation",
    orkestr: "Orkestr", operating: "Operating layer", deployment: "Deployment", resources: "Resources",
    developers: "Developers", documentation: "Documentation", company: "Company", team: "Team", contact: "Contact",
    customers: "Existing customers", portal: "Client Portal", note: "Managed implementations. Open-source operating core. Scope, deployment, access, and support vary by project.",
    breadcrumbHome: "Home", language: "Language", impressum: "Imprint", privacy: "Privacy", terms: "Terms",
  },
  de: {
    skip: "Zum Inhalt springen", home: "Orkestr Startseite", primary: "Hauptnavigation", menu: "Menü",
    build: "Leistungen", examples: "Beispiele", process: "Arbeitsweise", security: "Sicherheit", book: "Projektgespräch buchen",
    footer: "Wir konzipieren, bauen, modernisieren und betreiben Systeme für reale Geschäftsprozesse.", solutions: "Leistungen",
    newSystems: "Neue Systeme", modernization: "Systemmodernisierung", automation: "Arbeit & Daten automatisieren",
    orkestr: "Orkestr", operating: "Betriebsebene", deployment: "Betrieb", resources: "Ressourcen",
    developers: "Entwicklung", documentation: "Dokumentation", company: "Unternehmen", team: "Team", contact: "Kontakt",
    customers: "Bestehende Kunden", portal: "Kundenportal", note: "Betreute Implementierungen. Open-Source-Betriebskern. Umfang, Bereitstellung, Zugriff und Support werden je Projekt vereinbart.",
    breadcrumbHome: "Startseite", language: "Sprache", impressum: "Impressum", privacy: "Datenschutz", terms: "Nutzungsbedingungen",
  },
  tr: {
    skip: "İçeriğe geç", home: "Orkestr ana sayfa", primary: "Ana navigasyon", menu: "Menü",
    build: "Hizmetler", examples: "Örnekler", process: "Nasıl çalışıyoruz", security: "Güvenlik", book: "Proje görüşmesi planla",
    footer: "Gerçek iş süreçleri için sistemler tasarlıyor, geliştiriyor, modernleştiriyor ve işletiyoruz.", solutions: "Hizmetler",
    newSystems: "Yeni sistemler", modernization: "Sistem modernizasyonu", automation: "İş ve veri otomasyonu",
    orkestr: "Orkestr", operating: "İşletim katmanı", deployment: "Devreye alma", resources: "Kaynaklar",
    developers: "Geliştiriciler", documentation: "Dokümantasyon", company: "Şirket", team: "Ekip", contact: "İletişim",
    customers: "Mevcut müşteriler", portal: "Müşteri Portalı", note: "Yönetilen uygulamalar. Açık kaynak işletim çekirdeği. Kapsam, devreye alma, erişim ve destek her proje için ayrıca belirlenir.",
    breadcrumbHome: "Ana sayfa", language: "Dil", impressum: "Yasal bilgiler", privacy: "Gizlilik", terms: "Kullanım koşulları",
  },
};

function pageHref(pageId: PublicPageId, locale: PublicLocale, hash = "") {
  const path = publicPagePath(pageId, locale) || publicPagePath(pageId, "en") || "/";
  return `${path}${hash}`;
}

function navLink(id: PublicPageId, label: string, current: PublicPageId, locale: PublicLocale, event: string) {
  return `<a href="${pageHref(id, locale)}"${current === id ? ' aria-current="page"' : ""} data-event="${event}">${label}</a>`;
}

function languageSwitcher(page: PublicPage, mobile = false) {
  const current = page.locale || "en";
  const links = publicLocales.map((locale) => {
    const href = publicPagePath(page.id, locale) || publicPagePath("home", locale);
    return `<a href="${href}" hreflang="${publicLocaleTags[locale]}" lang="${locale}"${locale === current ? ' aria-current="page"' : ""}>${locale.toUpperCase()}</a>`;
  }).join("");
  if (mobile) return `<div class="language-switcher mobile-language-switcher" aria-label="${shellCopy[current].language}">${links}</div>`;
  return `<nav class="language-switcher" aria-label="${shellCopy[current].language}">${links}</nav>`;
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

function alternateLinks(page: PublicPage, env = process.env) {
  const links = publicLocales.map((locale) => {
    const path = publicPagePath(page.id, locale);
    const url = path ? publicCanonicalUrl(path, env) : "";
    return url ? `<link rel="alternate" hreflang="${publicLocaleTags[locale]}" href="${escapeHtml(url)}">` : "";
  }).filter(Boolean);
  const english = publicPagePath(page.id, "en");
  const fallback = english ? publicCanonicalUrl(english, env) : "";
  if (fallback && links.length > 1) links.push(`<link rel="alternate" hreflang="x-default" href="${escapeHtml(fallback)}">`);
  return links.join("\n  ");
}

function structuredData(page: PublicPage, env = process.env) {
  const base = publicSiteBaseUrl(env);
  if (!base) return "";
  const locale = page.locale || "en";
  const canonical = publicCanonicalUrl(page.canonicalPath || pageHref(page.id, locale), env);
  const repo = normalizePublicUrl(publicRepoUrl(env));
  const personId = `${base}/team#oguzcan-unver`;
  const graph: Array<Record<string, unknown>> = [
    {
      "@type": "Organization", "@id": `${base}/#organization`, name: "Orkestr", url: `${base}/`,
      founder: { "@id": personId }, ...(repo ? { sameAs: [repo] } : {}),
    },
    {
      "@type": "WebSite", "@id": `${base}/#website`, name: "Orkestr", url: `${base}/`,
      inLanguage: publicLocales.map((item) => publicLocaleTags[item]), publisher: { "@id": `${base}/#organization` },
    },
    {
      "@type": "Person", "@id": personId, name: "Oğuzcan Ünver", jobTitle: "Founder",
      worksFor: { "@id": `${base}/#organization` },
    },
  ];
  if (page.id !== "home" && canonical) {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: shellCopy[locale].breadcrumbHome, item: publicCanonicalUrl(pageHref("home", locale), env) },
        { "@type": "ListItem", position: 2, name: page.title, item: canonical },
      ],
    });
  }
  if (page.id === "team" && canonical) {
    graph.push({ "@type": "ProfilePage", "@id": `${canonical}#profile`, url: canonical, inLanguage: publicLocaleTags[locale], mainEntity: { "@id": personId } });
  }
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

export function renderPublicShell(page: PublicPage, env = process.env) {
  const locale = page.locale || "en";
  const copy = shellCopy[locale];
  const home = page.id === "home";
  const pageTitle = `${page.title} | Orkestr`;
  const canonical = publicCanonicalUrl(page.canonicalPath || pageHref(page.id, locale), env);
  const appUrl = publicAppUrl(env);
  const repo = publicRepoUrl(env);
  const homePath = pageHref("home", locale);
  return `<!doctype html>
<html lang="${publicLocaleTags[locale]}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(page.summary)}">
  <meta name="application-name" content="Orkestr">
  <meta name="robots" content="${page.indexable === false ? "noindex,follow" : "index,follow,max-image-preview:large"}">
  <meta name="theme-color" content="#f2efe6">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Orkestr">
  <meta property="og:locale" content="${publicLocaleOpenGraphTags[locale]}">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(page.summary)}">
  ${canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}"><link rel="canonical" href="${escapeHtml(canonical)}">` : ""}
  ${alternateLinks(page, env)}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(page.summary)}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/public-site.css">
  ${structuredData(page, env)}
</head>
<body class="page-${page.id} locale-${locale}">
  <a class="skip-link" href="#main-content">${copy.skip}</a>
  <header class="topbar">
    <a class="wordmark" href="${homePath}" aria-label="${copy.home}"><span>O</span> Orkestr</a>
    <nav class="desktop-nav" aria-label="${copy.primary}">
      ${navLink("use-cases", copy.build, page.id, locale, "nav_what_we_build")}
      <a href="${homePath}#examples" data-event="nav_examples">${copy.examples}</a>
      <a href="${homePath}#how-we-work" data-event="nav_how_we_work">${copy.process}</a>
      ${navLink("security", copy.security, page.id, locale, "nav_security")}
    </nav>
    <div class="header-actions">
      ${languageSwitcher(page)}
      <a class="button button-small" href="${pageHref("project", locale)}#book" data-event="book_project_header">${copy.book}</a>
    </div>
    <details class="mobile-menu">
      <summary aria-label="${copy.menu}">${copy.menu}</summary>
      <nav aria-label="${copy.primary}">
        <a href="${pageHref("use-cases", locale)}">${copy.build}</a><a href="${homePath}#examples">${copy.examples}</a><a href="${homePath}#how-we-work">${copy.process}</a><a href="${pageHref("security", locale)}">${copy.security}</a><a href="${pageHref("project", locale)}#book" data-event="book_project_mobile">${copy.book}</a>${languageSwitcher(page, true)}
      </nav>
    </details>
  </header>
  ${page.body}
  <footer class="footer">
    <div class="footer-brand"><a class="wordmark inverse" href="${homePath}"><span>O</span> Orkestr</a><p>${copy.footer}</p></div>
    <nav aria-label="${copy.solutions}"><strong>${copy.solutions}</strong><a href="${pageHref("websites-commerce", locale)}">${copy.newSystems}</a><a href="${pageHref("business-systems", locale)}">${copy.modernization}</a><a href="${pageHref("automation", locale)}">${copy.automation}</a></nav>
    <nav aria-label="${copy.orkestr}"><strong>${copy.orkestr}</strong><a href="${homePath}#how-we-work">${copy.process}</a><a href="${homePath}#platform">${copy.operating}</a><a href="${pageHref("deployment", locale)}">${copy.deployment}</a><a href="${pageHref("security", locale)}">${copy.security}</a></nav>
    <nav aria-label="${copy.resources}"><strong>${copy.resources}</strong><a href="/developers">${copy.developers}</a><a href="${escapeHtml(repo)}" rel="noreferrer">GitHub</a><a href="${escapeHtml(repo)}/tree/main/docs" rel="noreferrer">${copy.documentation}</a></nav>
    <nav aria-label="${copy.company}"><strong>${copy.company}</strong><a href="${pageHref("team", locale)}">${copy.team}</a><a href="/support">${copy.contact}</a><a href="/impressum">${copy.impressum}</a><a href="/privacy">${copy.privacy}</a><a href="/terms">${copy.terms}</a></nav>
    <nav aria-label="${copy.customers}"><strong>${copy.customers}</strong><a href="${escapeHtml(appUrl)}" data-event="client_portal_click">${copy.portal}</a></nav>
    <p class="footer-note">${copy.note}</p>
  </footer>
  ${analyticsScript(home)}
</body>
</html>`;
}
