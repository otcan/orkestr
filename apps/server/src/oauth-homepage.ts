export function renderOAuthHomepage(): string {
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
        <p>Google Workspace access is optional. Orkestr requests Google permissions only after a user starts the connection flow and approves the Google consent screen. Gmail read access is used to find and summarize messages the user asks about. Gmail draft and send access is used to prepare or send messages the user requests or approves. Gmail mailbox access is used to label, archive, or otherwise organize messages when requested. Google Calendar access is used to read or manage calendar events requested by the user.</p>
      </article>
      <article>
        <h2>User control and privacy</h2>
        <p>Users can disconnect Google access. Orkestr does not sell Google user data, use it for advertising, or use it to train general AI models. Connected-account data is used only to provide the workflow requested by the user.</p>
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
