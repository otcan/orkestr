import { googleWorkspaceAllowedCapabilities } from "../../../packages/connectors/src/google-workspace-scopes.js";

export function renderOAuthHomepage(env = process.env): string {
  const capabilities = googleWorkspaceAllowedCapabilities(env);
  const expandedGoogleAccess = capabilities.some((capability) => capability !== "gmail_send");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Orkestr</title>
  <meta name="application-name" content="Orkestr">
  <meta name="description" content="Orkestr is an invite-only AI assistant app for persistent chats, WhatsApp workflows, files, timers, private browser desktops, and user-approved Google Workspace connections.">
  <meta property="og:site_name" content="Orkestr">
  <meta property="og:title" content="Orkestr">
  <link rel="canonical" href="https://orkestr.de/about">
  <link rel="stylesheet" href="/public-site.css">
</head>
<body>
  <main class="legal-page">
    <section class="legal-hero">
      <p class="eyebrow">Orkestr application</p>
      <h1>Orkestr</h1>
      <p class="lead">Orkestr is an invite-only AI assistant app that helps users operate persistent chats, WhatsApp workflows, files, timers, and private browser desktops.</p>
    </section>
    <section class="legal-content" aria-label="About Orkestr">
      <article>
        <h2>What Orkestr does</h2>
        <p>Users ask Orkestr to complete work in a private agent workspace. Orkestr keeps each user's chats, files, timers, browser sessions, and connected accounts scoped to that user and performs only user-requested workflows.</p>
      </article>
      <article>
        <h2>How Orkestr uses Google data</h2>
        <p>${expandedGoogleAccess
          ? "Google Workspace access is optional. Users choose individual approved capabilities before Google's consent screen. Depending on that choice, Orkestr can prepare or send email, read selected Gmail signals, deliver notification previews, or read and manage owned-calendar events only for user-requested workflows."
          : "Google Workspace access is optional. The current public integration requests basic Google account identity and Gmail send access only after a user reviews Orkestr's data disclosure and continues to Google's consent screen. It sends only emails that the user requests or approves and cannot read the user's inbox or existing email."}</p>
      </article>
      <article>
        <h2>User control and privacy</h2>
        <p>Users can disconnect Google access and remove Orkestr's stored credentials. Google OAuth tokens are encrypted at rest and are never sent to an AI provider. Orkestr does not sell Google user data, use it for advertising, or use it to train generalized AI models.</p>
      </article>
      <article>
        <h2>Public information</h2>
        <p><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a> | <a href="/support">Support</a> | <a href="/">Orkestr home</a></p>
      </article>
    </section>
  </main>
</body>
</html>`;
}
