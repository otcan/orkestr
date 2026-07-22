import { googleWorkspacePrivacyPolicyVersion } from "../../../packages/connectors/src/google-workspace-privacy.js";

type PrivacyPage = {
  title: string;
  heading: string;
  summary: string;
  body: string;
};

export const publicPrivacyPolicyVersion = googleWorkspacePrivacyPolicyVersion;

function clean(value = "") {
  return String(value || "").trim();
}

function escapeHtml(value = "") {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function operatorDetails(env = process.env) {
  const name = clean(env.ORKESTR_PUBLIC_OPERATOR_NAME || "Orkestr");
  const address = clean(env.ORKESTR_PUBLIC_OPERATOR_ADDRESS);
  const contact = clean(env.ORKESTR_PUBLIC_CONTACT || env.ORKESTR_SUPPORT_EMAIL || "Ask the person who invited you.");
  return { name, address, contact };
}

function contactHtml(contact = "") {
  const value = escapeHtml(contact);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(contact))
    ? `<a href="mailto:${value}">${value}</a>`
    : value;
}

export function publicPrivacyPage(env = process.env): PrivacyPage {
  const operator = operatorDetails(env);
  const operatorAddress = operator.address ? `, ${escapeHtml(operator.address)}` : "";
  return {
    title: "Privacy",
    heading: "Privacy",
    summary: "How Orkestr accesses, uses, stores, protects, and shares personal information and Google user data.",
    body: `<main class="legal-page privacy-policy">
  <section class="legal-hero">
    <p class="eyebrow">Data handling</p>
    <h1>Privacy Policy</h1>
    <p class="lead">This policy explains how Orkestr accesses, uses, stores, protects, and shares personal information, including data connected through Google Workspace.</p>
    <p class="policy-meta">Version ${publicPrivacyPolicyVersion} · Effective July 23, 2026</p>
  </section>
  <section class="legal-content">
    <article id="scope">
      <h2>1. Scope and operator</h2>
      <p>This policy applies to the hosted Orkestr service available through orkestr.de and its official connection pages. The hosted beta is operated by ${escapeHtml(operator.name)}${operatorAddress}. Contact: ${contactHtml(operator.contact)}.</p>
      <p>Independent self-hosted installations are controlled by their respective operators. Unless a self-hosted operator connects that installation to an Orkestr-hosted service, the Orkestr hosted service does not receive data from that installation.</p>
    </article>
    <article id="data-we-process">
      <h2>2. Information Orkestr processes</h2>
      <p>Orkestr processes information needed to provide user-requested workflows: account and contact details, chat messages, files, task outputs, timers, workspace records, connector status, managed-browser activity, security records, and technical service logs. Orkestr does not ask users to provide account passwords through chat.</p>
    </article>
    <article id="google-data-access">
      <h2>3. Google user data Orkestr accesses</h2>
      <p>The current public Google integration requests only basic Google identity permissions and Gmail send access: <code>openid</code>, <code>userinfo.email</code>, <code>userinfo.profile</code>, and <code>gmail.send</code>.</p>
      <ul>
        <li><strong>Google identity:</strong> account identifier, email address, name, and available profile information used to identify the connected account.</li>
        <li><strong>Authorization data:</strong> granted scopes, access token, refresh token when issued, token type, expiration time, and connection status.</li>
        <li><strong>User-approved outgoing email:</strong> sender account, recipients, subject, body, and attachments that the user requests or approves for sending.</li>
        <li><strong>Delivery metadata:</strong> identifiers and status returned by Gmail after the requested send operation.</li>
      </ul>
      <p><strong>Orkestr's current public Gmail integration cannot and does not read the user's inbox, existing messages, drafts, labels, contacts, mailbox settings, or email history.</strong> If Orkestr introduces a capability requiring additional Google scopes, it will update this policy and the in-product disclosure and obtain new consent before requesting that access.</p>
    </article>
    <article id="google-data-use">
      <h2>4. How Orkestr uses Google user data</h2>
      <p>Orkestr uses Google identity data to display and manage the connected account, authorization data to maintain the connection, outgoing-email content to perform a send explicitly requested or approved by the user, and delivery metadata to report the result. Google user data is not used for unrelated purposes.</p>
    </article>
    <article id="google-data-sharing">
      <h2>5. Sharing and disclosure of Google user data</h2>
      <p>Orkestr does not sell Google user data. It does not provide Google user data to advertising platforms, data brokers, or information resellers, and does not use it for advertising, credit decisions, or generalized AI or machine-learning model training.</p>
      <p>Data is disclosed only in these limited circumstances:</p>
      <ul>
        <li><strong>Google:</strong> Orkestr sends the user-approved email and credentials required to authenticate the request to Google's OAuth and Gmail services.</li>
        <li><strong>Configured AI provider:</strong> a provider such as OpenAI may process prompts and email content supplied or approved by the user when the user asks the agent to prepare or perform that workflow. Google OAuth access and refresh tokens are never disclosed to an AI provider. The current integration does not retrieve existing Gmail content for AI processing.</li>
        <li><strong>User-selected communication provider:</strong> when the user works through WhatsApp, Meta's WhatsApp service carries the user's instructions and Orkestr's status or result messages.</li>
        <li><strong>Infrastructure and security providers:</strong> hosting, storage, networking, monitoring, and security processors may handle encrypted or operational data only as needed to operate and protect the service.</li>
        <li><strong>Support, security, and law:</strong> authorized human access or disclosure may occur only with the user's explicit support request, to investigate abuse or a security incident, or where required by applicable law.</li>
      </ul>
      <p>Service providers are permitted to process data only for the service purpose for which it was disclosed and must protect it appropriately.</p>
    </article>
    <article id="google-data-storage">
      <h2>6. Storage and retention</h2>
      <p>Google OAuth credentials are stored in the connected user's isolated connector storage and retained until the user disconnects the account, the grant is revoked, the account is deleted, or the credentials expire and are no longer needed. A disconnect requests revocation from Google before deleting the local credential record.</p>
      <p>Outgoing-email content may remain in the user's Orkestr chat or task history when it forms part of the user-visible workflow. It is not maintained as a separate copy of the user's Gmail mailbox. Connection requests are one-time and expire. Encrypted credential records may remain temporarily in protected operational backups until those backups rotate.</p>
    </article>
    <article id="google-data-protection">
      <h2>7. Data protection mechanisms</h2>
      <ul>
        <li>HTTPS/TLS protects Google authorization and service traffic in transit.</li>
        <li>Google OAuth access and refresh tokens are encrypted at rest with AES-256-GCM.</li>
        <li>Production encryption keys are stored separately from encrypted token records and are restricted to the Orkestr service account.</li>
        <li>Connector records are scoped by user and protected by authenticated access controls and private filesystem permissions.</li>
        <li>Orkestr requests the minimum approved Google scopes and blocks undeclared capabilities in both the user interface and server.</li>
        <li>Credentials are excluded from public responses, agent context, screenshots, source control, and operational event records.</li>
      </ul>
      <p>No system can guarantee absolute security. Suspected unauthorized access is investigated and affected users and authorities are notified when required.</p>
    </article>
    <article id="google-limited-use">
      <h2>8. Google API Services User Data Policy</h2>
      <p>Orkestr's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements. Google Workspace data is used only to provide or improve the user-facing feature requested by the user.</p>
    </article>
    <article id="deletion">
      <h2>9. User controls, revocation, and deletion</h2>
      <p>Users can decline Google access and continue using Orkestr without Gmail. A connected account can be disconnected from Orkestr setup, which revokes the Google grant and removes locally stored credentials. Users can also revoke Orkestr from their Google Account permissions page.</p>
      <p>Users may request access, correction, export, restriction, or deletion of their Orkestr data through the invitation chat, the <a href="/data-deletion">data deletion page</a>, or ${contactHtml(operator.contact)}. Some minimal records may be retained where required for security, abuse prevention, dispute handling, or law.</p>
    </article>
    <article id="legal-bases">
      <h2>10. Legal bases and international processing</h2>
      <p>Depending on the context, Orkestr processes data to provide the service requested by the user, based on the user's consent for optional connectors, for legitimate security and reliability interests, and to meet legal obligations. Providers may process data in countries outside the user's country; Orkestr relies on the provider's applicable contractual and legal transfer safeguards.</p>
    </article>
    <article id="policy-changes">
      <h2>11. Changes and contact</h2>
      <p>Material changes to Google data access, use, or sharing will be reflected here and in the in-product disclosure before new access is requested. Questions or privacy requests can be sent to ${contactHtml(operator.contact)}.</p>
    </article>
  </section>
</main>`,
  };
}
