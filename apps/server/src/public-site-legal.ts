import { renderWaitlistSection } from "./public-waitlist.js";
import { publicPrivacyPage } from "./public-privacy.js";
import { escapeHtml, publicContact, publicRepoUrl, type PublicPage, type PublicPageId } from "./public-site-config.js";

function legalBody(eyebrow: string, heading: string, intro: string, sections: Array<[string, string]>) {
  return `<main class="legal-page" id="main-content"><section class="legal-hero"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(heading)}</h1><p class="lead">${escapeHtml(intro)}</p></section><section class="legal-content">${sections.map(([title, text]) => `<article><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></article>`).join("")}</section></main>`;
}

export function legalPage(pageId: PublicPageId, env = process.env): PublicPage {
  if (pageId === "privacy") return { id: "privacy", canonicalPath: "/privacy", ...publicPrivacyPage(env) };
  const pages: Partial<Record<PublicPageId, PublicPage>> = {
    terms: {
      id: "terms", title: "Terms", summary: "Plain-language terms for Orkestr's public-alpha software, private beta, and commercial inquiries.",
      body: legalBody("TERMS", "Terms", "Orkestr is public-alpha software. The personal beta is invite-only, and submitting a commercial workflow inquiry is not a purchase agreement.", [
        ["Your responsibility", "Only connect accounts and systems you own or are authorized to use. Do not ask Orkestr to impersonate people, steal data, break laws, run scams, or bypass account controls."],
        ["Service behavior", "Orkestr may process instructions, files, connector metadata, managed-browser activity, timers, and task outputs to perform an authorized workflow. Review important outputs before consequential action."],
        ["Alpha and beta availability", "Features can fail, change, or be withdrawn. The operator may pause a deployment or account for reliability, security, legal, or abuse-prevention reasons."],
        ["Commercial inquiries", "Submitting a workflow map or scheduling a qualification call asks Orkestr to assess a possible pilot. It does not guarantee availability, scope, price, schedule, or delivery."],
        ["Open source", `The generic public core is available at ${publicRepoUrl(env)}. Private deployment overlays, customer configuration, operational evidence, and secrets are not part of the OSS repository.`],
      ]),
    },
    "acceptable-use": {
      id: "acceptable-use", title: "Acceptable Use", summary: "Allowed and disallowed use for Orkestr public-alpha software, beta users, and managed workflows.",
      body: legalBody("SAFETY", "Acceptable use", "Orkestr is for authorized personal and operational workflows. It is not for unauthorized access, deception, harassment, spam, scams, or data theft.", [
        ["Allowed", "Use authorized systems, manage approved files, run legitimate research, automate bounded workflows, and ask for help with normal work."],
        ["Not allowed", "Do not access accounts without permission, extract private data without authority, evade security controls, send abusive or deceptive messages, or automate unlawful decisions."],
        ["Human control", "Do not remove required human review from high-impact, irreversible, regulated, financial, employment, access-control, or safety-related decisions."],
        ["Enforcement", "The operator may pause or offboard accounts and deployments that appear unsafe, abusive, illegal, or outside the agreed scope."],
      ]),
    },
    "data-deletion": {
      id: "data-deletion", title: "Data Deletion", summary: "How Orkestr users and commercial contacts can request access, export, pause, revocation, or deletion.",
      body: legalBody("CONTROL", "Data deletion and export", "Users and commercial contacts can request access, correction, export, pause, connector revocation, or deletion through the operator contact.", [
        ["Pause", "Ask the operator to stop new work and disable access while the scope or incident is reviewed."],
        ["Export", "Ask for an export of user-visible data where practical, such as files, workflow records, and chat or task history."],
        ["Connector revocation", "Disconnect a provider through Orkestr setup and, where available, revoke Orkestr directly in the provider account."],
        ["Commercial contact deletion", "Commercial contacts may ask for their inquiry record to be deleted unless a minimal record must be retained for security, dispute handling, or law."],
        ["Contact", publicContact(env)],
      ]),
    },
    support: {
      id: "support", title: "Support", summary: "Support paths for Orkestr public-alpha users, private beta users, and managed deployments.",
      body: legalBody("HELP", "Support", "Use the support path agreed for your deployment or the public operator contact. Never send credentials in a support message.", [
        ["Managed deployment", "Report what failed, the workflow and step involved, the expected result, and whether a connector or managed resource was active. Follow the agreed incident and release boundary."],
        ["Personal beta", "Send a normal message in the invitation chat explaining what failed and what you expected."],
        ["Self-hosted OSS", "Use public documentation and repository issue templates for generic, publishable problems. Do not attach private configuration, logs containing secrets, or customer data."],
        ["Urgent pause", "Ask the operator to pause the workflow, user, connector, or deployment if it may be behaving incorrectly."],
        ["Contact", publicContact(env)],
      ]),
    },
    beta: {
      id: "beta", title: "Personal Beta", summary: "The preserved invite-only Orkestr personal beta, including consent disclosures and access request flow.",
      body: `<main class="legal-page beta-page" id="main-content"><section class="legal-hero"><p class="eyebrow">PERSONAL BETA</p><h1>Start a private Orkestr workspace.</h1><p class="lead">The personal experience remains invite-only and separate from commercial Workflow Pilot inquiries.</p></section><section class="legal-content"><article><h2>Invite-only</h2><p>Access is limited to people explicitly invited by the operator.</p></article><article><h2>Expected instability</h2><p>Features can fail, responses can be imperfect, and live connectors may need manual repair.</p></article><article><h2>Human review</h2><p>Review important output before sending, publishing, paying, applying, or taking irreversible action.</p></article><article><h2>Consent and control</h2><p>Requesting access requires the beta terms and privacy notice. Connected accounts can be declined, disconnected, or revoked.</p></article></section>${renderWaitlistSection()}</main>`,
    },
  };
  return pages[pageId] || pages.beta!;
}
