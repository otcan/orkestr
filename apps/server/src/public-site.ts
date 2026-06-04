import { renderWaitlistSection, waitlistCss } from "./public-waitlist.js";

type PublicPage = {
  title: string;
  eyebrow?: string;
  heading: string;
  summary: string;
  body: string;
};

const defaultRepoUrl = "https://github.com/otcan/orkestr";

function clean(value = "") {
  return String(value || "").trim();
}

function normalizeUrl(value = "") {
  const text = clean(value).replace(/\/+$/, "");
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function hostFromValue(value = "") {
  const text = clean(value).replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^\.+/, "").replace(/\.+$/, "");
  return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(text) ? text.toLowerCase() : "";
}

function requestHost(value = "") {
  const first = clean(value).split(",")[0] || "";
  return hostFromValue(first);
}

function escapeHtml(value = "") {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function publicRepoUrl(env = process.env) {
  return clean(env.ORKESTR_PUBLIC_REPO_URL || env.ORKESTR_REPO_URL || defaultRepoUrl);
}

function publicContact(env = process.env) {
  return clean(env.ORKESTR_PUBLIC_CONTACT || env.ORKESTR_SUPPORT_EMAIL || "Ask the person who invited you.");
}

export function publicSiteBaseUrl(env = process.env) {
  const configured = normalizeUrl(env.ORKESTR_PUBLIC_SITE_URL || env.ORKESTR_PRIMARY_PUBLIC_URL || "");
  if (configured) return configured;
  const primary = hostFromValue(env.ORKESTR_PRIMARY_DOMAIN || env.ORKESTR_DOMAIN || "");
  return primary ? `https://${primary}` : "";
}

export function publicSiteHost(env = process.env) {
  return requestHost(publicSiteBaseUrl(env));
}

export function publicSiteAllowedForHost(hostHeader = "", env = process.env) {
  const expected = publicSiteHost(env);
  if (!expected) return true;
  const actual = requestHost(hostHeader);
  if (!actual) return true;
  return actual === expected || actual === `www.${expected}` || (expected.startsWith("www.") && actual === expected.slice(4));
}

export function publicPairingUrl(env = process.env) {
  const configured = normalizeUrl(env.ORKESTR_PUBLIC_AUTH_URL || env.ORKESTR_AUTH_ENTRY_URL || env.ORKESTR_PAIRING_URL || "");
  const base = configured || publicSiteBaseUrl(env);
  if (!base) return "";
  try {
    return new URL("/setup/pairing", base).toString();
  } catch {
    return "";
  }
}

export function publicSitePath(pathname = "") {
  const path = clean(pathname || "/").replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/public") return "home";
  if (path === "/terms") return "terms";
  if (path === "/privacy") return "privacy";
  if (path === "/acceptable-use") return "acceptable-use";
  if (path === "/data-deletion") return "data-deletion";
  if (path === "/support") return "support";
  if (path === "/beta") return "beta";
  return "";
}

export function renderPublicSite(requestUrl = "/", env = process.env, options: { host?: string } = {}) {
  if (!publicSiteAllowedForHost(options.host || "", env)) return "";
  const url = new URL(requestUrl || "/", "http://localhost");
  const pageId = publicSitePath(url.pathname);
  if (!pageId) return "";
  if (pageId === "home") return renderHome(env);
  return renderLegalPage(pageId, env);
}

function shell(page: PublicPage, env = process.env) {
  const repo = publicRepoUrl(env);
  const title = escapeHtml(page.title ? `${page.title} | Orkestr` : "Orkestr");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${escapeHtml(page.summary)}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>${publicCss()}</style>
</head>
<body>
  <header class="topbar">
    <a class="wordmark" href="/" aria-label="Orkestr home">Orkestr</a>
    <nav aria-label="Public navigation">
      <a href="${escapeHtml(repo)}" rel="noreferrer">Repo</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a class="button small" href="/#waitlist">Join waitlist</a>
    </nav>
  </header>
  ${page.body}
  <footer class="footer">
    <strong>Orkestr</strong>
    <span>Invite-only private beta.</span>
    <nav aria-label="Legal links">
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="/acceptable-use">Acceptable Use</a>
      <a href="/data-deletion">Data Deletion</a>
      <a href="/support">Support</a>
      <a href="/beta">Beta</a>
    </nav>
  </footer>
</body>
</html>`;
}

function renderHome(env = process.env) {
  const repo = publicRepoUrl(env);
  const contact = publicContact(env);
  return shell({
    title: "Invite-only agent workstation",
    summary: "Orkestr is a self-hosted agent workstation for persistent AI chats, WhatsApp, desktops, timers, files, and user-owned connectors.",
    heading: "Orkestr",
    body: `<main>
  <section class="hero">
    <div class="hero-shade"></div>
    <div class="hero-copy">
      <p class="eyebrow">Invite-only private beta</p>
      <h1>Orkestr</h1>
      <p class="lead">A self-hosted agent workstation for persistent AI chats, WhatsApp, managed desktops, timers, files, and user-owned connectors.</p>
      <div class="actions">
        <a class="button" href="#waitlist">Join waitlist</a>
        <a class="button secondary" href="${escapeHtml(repo)}" rel="noreferrer">View OSS repo</a>
      </div>
      <p class="contact">Invite-only beta access starts with your WhatsApp number. ${escapeHtml(contact)}</p>
    </div>
  </section>
  ${renderWaitlistSection()}
  <section class="band intro" aria-labelledby="how-title">
    <div>
      <p class="eyebrow">How it works</p>
      <h2 id="how-title">You use chat. Orkestr keeps the workspace alive.</h2>
      <p>Invited users start in WhatsApp, connect only the accounts they choose, and use an isolated workspace, files area, timers, and managed desktop.</p>
    </div>
    <ol class="flow">
      <li><strong>Get invited.</strong><span>Your inviter sends the beta terms and creates your private chat.</span></li>
      <li><strong>Reply with consent.</strong><span>You confirm that you understand what Orkestr may process.</span></li>
      <li><strong>Start in WhatsApp.</strong><span>Ask for help, connect capabilities by chat, and keep working there.</span></li>
      <li><strong>Use your own accounts.</strong><span>OAuth and desktop logins are scoped to your user account.</span></li>
    </ol>
  </section>
  <section class="band split" aria-labelledby="capabilities-title">
    <div>
      <p class="eyebrow">Capabilities</p>
      <h2 id="capabilities-title">Built for useful personal automation.</h2>
      <p>Orkestr can help with files, timers, managed browser work, WhatsApp workflows, and user-connected services such as Gmail, Outlook, Jira, and Shopify.</p>
    </div>
    <ul class="feature-list">
      <li>Persistent agent threads</li>
      <li>WhatsApp chat routing</li>
      <li>Managed browser desktops</li>
      <li>User-scoped skills and files</li>
      <li>Parent-managed connector apps</li>
      <li>Export, deletion, pause, and support paths</li>
    </ul>
  </section>
  <section class="band trust" aria-labelledby="trust-title">
    <div>
      <p class="eyebrow">Trust model</p>
      <h2 id="trust-title">You stay in control of what gets connected.</h2>
      <p>The public repo contains generic product code. Real deployments keep secrets, browser profiles, WhatsApp sessions, and private overlays outside the OSS repository.</p>
    </div>
    <div class="links">
      <a href="/privacy">Privacy</a>
      <a href="/acceptable-use">Acceptable use</a>
      <a href="/data-deletion">Deletion and export</a>
      <a href="/support">Support</a>
    </div>
  </section>
</main>`,
  }, env);
}

function renderLegalPage(pageId: string, env = process.env) {
  const pages: Record<string, PublicPage> = {
    terms: {
      title: "Terms",
      heading: "Terms",
      summary: "The plain-language beta terms for invited Orkestr users.",
      body: legalBody({
        eyebrow: "Beta terms",
        heading: "Terms",
        intro: "Orkestr is currently invite-only beta software. Use it only if you were invited and you understand that beta features can fail or change.",
        sections: [
          ["Your responsibility", "Only connect accounts you own or are authorized to use. Do not ask Orkestr to impersonate people, steal data, break laws, run scams, or bypass account controls."],
          ["Service behavior", "Orkestr may process your chat messages, files you provide, connector metadata, desktop activity, timers, and task outputs to perform requested work."],
          ["Beta availability", "The service can be paused, changed, or withdrawn during the beta. Important work should be checked by you before relying on it."],
          ["Open source", `The public repository is available at ${publicRepoUrl(env)}. Private deployment overlays and secrets are not part of the OSS repo.`],
        ],
      }),
    },
    privacy: {
      title: "Privacy",
      heading: "Privacy",
      summary: "How Orkestr treats user data during the invite-only beta.",
      body: legalBody({
        eyebrow: "Data handling",
        heading: "Privacy",
        intro: "Orkestr stores and processes the minimum data needed to run your user-scoped chats, workspaces, timers, desktops, and connected accounts.",
        sections: [
          ["What may be processed", "Chat messages, files you upload or create, timers, connector status, OAuth grants, managed desktop state, and task outputs may be processed for your requested workflows."],
          ["Connector accounts", "Parent connector apps can provide OAuth entry points, but the account grants belong to the user who connects them."],
          ["Google Workspace API data", "Orkestr's use and transfer of information received from Google Workspace APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements."],
          ["Isolation goal", "External users should receive user-scoped resources and should not see admin chats, private overlays, secrets, or other users' data."],
          ["Deletion and export", "Use the deletion and export instructions to ask the operator to pause, export, or remove your beta data."],
        ],
      }),
    },
    "acceptable-use": {
      title: "Acceptable Use",
      heading: "Acceptable Use",
      summary: "Allowed and disallowed use for Orkestr beta users.",
      body: legalBody({
        eyebrow: "Safety",
        heading: "Acceptable Use",
        intro: "Orkestr is for legitimate personal and work automation. It is not for unauthorized access, deception, harassment, spam, scams, or data theft.",
        sections: [
          ["Allowed", "Use your own accounts, manage your own files, run legitimate research, automate approved workflows, and ask for help with normal work."],
          ["Not allowed", "Do not use Orkestr to access accounts you do not control, extract private data without permission, run scams, evade security systems, or send abusive messages."],
          ["Enforcement", "The operator may pause or offboard accounts that appear unsafe, abusive, or outside the beta scope."],
        ],
      }),
    },
    "data-deletion": {
      title: "Data Deletion",
      heading: "Data Deletion",
      summary: "How invited users can request export, pause, or deletion.",
      body: legalBody({
        eyebrow: "Control",
        heading: "Data deletion and export",
        intro: "Invited users can request pause, export, connector revocation, or deletion from the same WhatsApp chat used for Orkestr.",
        sections: [
          ["Pause", "Ask to pause your Orkestr user. The operator can stop new work and disable access while preserving data for review."],
          ["Export", "Ask for an export of user-visible data where practical, such as files and chat/task records."],
          ["Deletion", "Ask for deletion when you want beta data removed. Some records may be retained only where required for security, abuse prevention, or legal reasons."],
          ["Contact", publicContact(env)],
        ],
      }),
    },
    support: {
      title: "Support",
      heading: "Support",
      summary: "How invited beta users can get support.",
      body: legalBody({
        eyebrow: "Help",
        heading: "Support",
        intro: "For the invite-only beta, support starts with the person or chat that invited you.",
        sections: [
          ["Chat support", "Send a normal WhatsApp message explaining what failed, what you expected, and whether a connector or desktop was involved."],
          ["Account access", "Never paste passwords into Orkestr. Use the provided OAuth or managed desktop login flow when an account must be connected."],
          ["Urgent pause", "Ask the operator to pause your user if you believe a connector, desktop, or task is behaving incorrectly."],
          ["Contact", publicContact(env)],
        ],
      }),
    },
    beta: {
      title: "Beta",
      heading: "Beta",
      summary: "The Orkestr beta disclosure for invited users.",
      body: legalBody({
        eyebrow: "Private beta",
        heading: "Beta disclosure",
        intro: "Orkestr is beta software. The goal is to learn from real workflows with a small set of invited users before opening access more broadly.",
        sections: [
          ["Invite-only", "Access is limited to people explicitly invited by the operator."],
          ["Expected instability", "Features can fail, responses can be imperfect, and live connectors may need manual repair."],
          ["Human review", "Review important outputs before sending, publishing, paying, applying, or taking irreversible action."],
          ["Feedback", "Use the beta chat to report confusing answers, unsafe behavior, missing capabilities, or broken setup steps."],
        ],
      }),
    },
  };
  return shell(pages[pageId] || pages.beta, env);
}

function legalBody({
  eyebrow,
  heading,
  intro,
  sections,
}: {
  eyebrow: string;
  heading: string;
  intro: string;
  sections: Array<[string, string]>;
}) {
  return `<main class="legal-page">
  <section class="legal-hero">
    <p class="eyebrow">${escapeHtml(eyebrow)}</p>
    <h1>${escapeHtml(heading)}</h1>
    <p class="lead">${escapeHtml(intro)}</p>
  </section>
  <section class="legal-content">
    ${sections.map(([title, text]) => `<article><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></article>`).join("\n    ")}
  </section>
</main>`;
}

function publicCss() {
  return `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #17202a;
  background: #f7f8fa;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #f7f8fa; }
a { color: inherit; }
.topbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 68px;
  padding: 14px clamp(18px, 5vw, 64px);
  background: rgba(247, 248, 250, 0.92);
  border-bottom: 1px solid rgba(23, 32, 42, 0.12);
  backdrop-filter: blur(12px);
}
.wordmark { font-weight: 800; font-size: 20px; text-decoration: none; letter-spacing: 0; }
nav { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
nav a { color: #334155; font-size: 14px; font-weight: 700; text-decoration: none; }
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid #1f2937;
  border-radius: 6px;
  background: #111827;
  color: #fff;
  font-weight: 800;
  text-decoration: none;
}
.button.secondary { background: rgba(255, 255, 255, 0.84); color: #111827; border-color: rgba(255, 255, 255, 0.78); }
.button.small { min-height: 36px; padding: 0 13px; color: #fff; }
.hero {
  position: relative;
  min-height: 92vh;
  display: flex;
  align-items: end;
  padding: 118px clamp(20px, 6vw, 80px) 72px;
  background: #1b252f url("/public-assets/orkestr-three-screen-demo.png") center / cover no-repeat;
  color: #fff;
}
.hero-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(9, 14, 21, 0.92) 0%, rgba(9, 14, 21, 0.66) 48%, rgba(9, 14, 21, 0.28) 100%);
}
.hero-copy { position: relative; width: min(760px, 100%); }
.eyebrow { margin: 0 0 12px; color: #2b7a78; font-size: 12px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; }
.hero .eyebrow { color: #7dd3fc; }
h1 { margin: 0; font-size: clamp(52px, 10vw, 104px); line-height: 0.92; letter-spacing: 0; }
h2 { margin: 0 0 14px; font-size: clamp(28px, 4vw, 48px); line-height: 1.04; letter-spacing: 0; }
.lead { margin: 18px 0 0; max-width: 690px; font-size: clamp(20px, 2.3vw, 30px); line-height: 1.22; color: rgba(255, 255, 255, 0.9); }
.actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 28px; }
.contact { margin: 18px 0 0; max-width: 650px; color: rgba(255, 255, 255, 0.78); line-height: 1.5; }
.band {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(280px, 1.05fr);
  gap: clamp(28px, 6vw, 80px);
  padding: clamp(52px, 8vw, 92px) clamp(20px, 6vw, 80px);
  border-bottom: 1px solid rgba(23, 32, 42, 0.1);
}
.band p { margin: 0; color: #475569; font-size: 18px; line-height: 1.55; }
${waitlistCss()}
.flow, .feature-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.flow li, .feature-list li {
  display: grid;
  gap: 5px;
  padding: 18px;
  border: 1px solid rgba(23, 32, 42, 0.12);
  border-radius: 8px;
  background: #fff;
}
.flow span { color: #64748b; line-height: 1.45; }
.feature-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.trust { background: #e8f1ef; }
.links { display: grid; gap: 10px; align-content: start; }
.links a {
  padding: 16px 0;
  border-bottom: 1px solid rgba(23, 32, 42, 0.18);
  color: #17202a;
  font-weight: 800;
  text-decoration: none;
}
.legal-page { padding-top: 68px; }
.legal-hero {
  padding: clamp(74px, 10vw, 120px) clamp(20px, 6vw, 80px) clamp(34px, 5vw, 60px);
  background: #e8f1ef;
}
.legal-hero h1 { color: #17202a; }
.legal-hero .lead { color: #334155; max-width: 850px; }
.legal-content {
  display: grid;
  gap: 1px;
  max-width: 960px;
  padding: 42px clamp(20px, 6vw, 80px) 82px;
}
.legal-content article {
  padding: 24px 0;
  border-bottom: 1px solid rgba(23, 32, 42, 0.12);
}
.legal-content h2 { margin: 0 0 8px; font-size: 24px; }
.legal-content p { margin: 0; color: #475569; font-size: 17px; line-height: 1.55; }
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 26px clamp(20px, 6vw, 80px);
  background: #111827;
  color: #e5e7eb;
  flex-wrap: wrap;
}
.footer span { color: #94a3b8; }
.footer nav a { color: #e5e7eb; }
@media (max-width: 760px) {
  .topbar { position: sticky; min-height: auto; }
  .topbar nav { justify-content: flex-end; gap: 10px; }
  .topbar nav a:not(.button) { display: none; }
  .hero { min-height: 88vh; padding-top: 74px; }
  .hero-shade { background: rgba(9, 14, 21, 0.74); }
  .band { grid-template-columns: 1fr; }
  .feature-list { grid-template-columns: 1fr; }
}
`;
}
