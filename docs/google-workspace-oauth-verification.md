# Google Workspace OAuth Verification Prep

Orkestr supports a WhatsApp-first Google Workspace connection flow for
user-owned accounts. The parent Orkestr install owns the Google OAuth client,
but each user's grant and token are scoped to that user.

## User Flow

1. The user sends `/connect google` in their WhatsApp-bound Orkestr chat.
2. Orkestr replies with a one-time `/connect/google` link.
3. The web page asks the user to select capabilities before redirecting to
   Google OAuth.
4. Orkestr requests only the scopes required by the selected capabilities.
5. If Google grants only some optional scopes, Orkestr stores and exposes only
   the granted capabilities.
6. The chat receives a success or failure confirmation.

## Recommended Publishing Phases

Phase 1 should publish the public Orkestr Google app with the narrowest useful
Gmail flow:

- App identity: `openid`, `userinfo.email`, and `userinfo.profile`
- Gmail send: `https://www.googleapis.com/auth/gmail.send`

This supports user-approved outbound Gmail actions without requesting Gmail
read, mailbox modification, or draft/compose access by default.

Phase 2 can add restricted Gmail capabilities after the first public app is
approved and the review/demo materials justify the added access:

- Gmail read: `https://www.googleapis.com/auth/gmail.readonly`
- Gmail actions: `https://www.googleapis.com/auth/gmail.modify`
- Gmail drafts: `https://www.googleapis.com/auth/gmail.compose`

Keep restricted scopes optional in the Orkestr consent page. Do not make them a
silent default.

## Google Cloud Console Values

Use the `orkestr-de-public` Google Cloud project.

- App name: `Orkestr`
- User support email: the support mailbox for `orkestr.de`
- Authorized domain: `orkestr.de`
- Application home page: `https://orkestr.de/`
- Privacy policy: `https://orkestr.de/privacy`
- Terms of service: `https://orkestr.de/terms`
- Support page: `https://orkestr.de/support`

The public homepage must be accessible without login and must visibly identify
the submitted app as `Orkestr`. It should explain that Orkestr is an
invite-only assistant app and self-hosted agent workstation, and should state
why Google Workspace/Gmail permissions are requested.

The authorized redirect URI must exactly match the runtime callback base. For
the public connector entrypoint, register:

```text
https://connect.orkestr.de/oauth/gmail/callback
```

If a deployment uses a different `GMAIL_OAUTH_REDIRECT_URI`, register that exact
URI as well.

## Capability Scopes

Base identity is requested for every Google Workspace connection:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`

Optional capabilities map to scopes as follows:

- Gmail read: `https://www.googleapis.com/auth/gmail.readonly`
- Gmail labels/archive/read-unread: `https://www.googleapis.com/auth/gmail.modify`
- Gmail send: `https://www.googleapis.com/auth/gmail.send`
- Gmail drafts: `https://www.googleapis.com/auth/gmail.compose`
- Calendar read: `https://www.googleapis.com/auth/calendar.events.readonly`
- Calendar actions: `https://www.googleapis.com/auth/calendar.events`
- Drive selected files: `https://www.googleapis.com/auth/drive.file`

Orkestr must not request broad Drive scopes for this flow. Drive access is
limited to files selected or created through Orkestr by `drive.file`.

## Verification Demo Checklist

Use generic demo data only.

- Show the WhatsApp `/connect google` command and the one-time link reply.
- Briefly show the public `https://orkestr.de/` homepage with the app name,
  purpose, and privacy/terms links.
- Show the capability disclosure page before Google OAuth.
- Select Gmail send only for the first public verification demo, then complete
  Google OAuth.
- Show the WhatsApp confirmation listing enabled capabilities.
- Demonstrate a user-approved Gmail send action.
- Demonstrate a Gmail read action only if `gmail.readonly` is selected.
- Demonstrate a Gmail label/archive/read-unread action if `gmail.modify` was
  selected.
- Demonstrate draft creation or draft sending only if `gmail.compose` was
  selected.
- Demonstrate Calendar event listing if Calendar read was selected.
- Demonstrate creating, updating, or deleting a test Calendar event if Calendar
  actions was selected.
- Demonstrate Drive selected-file metadata or text content access if
  `drive.file` was selected.
- Show that unselected or ungranted capabilities are unavailable.

Do not include refresh tokens, OAuth client secrets, real private messages,
private file IDs, phone numbers, session state, local paths, or private hostnames
in public verification material.
