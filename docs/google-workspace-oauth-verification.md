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

## Capability Scopes

Base identity is requested for every Google Workspace connection:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`

Optional capabilities map to scopes as follows:

- Gmail read: `https://www.googleapis.com/auth/gmail.readonly`
- Gmail labels/archive/read-unread: `https://www.googleapis.com/auth/gmail.modify`
- Gmail send/drafts: `https://www.googleapis.com/auth/gmail.send`,
  `https://www.googleapis.com/auth/gmail.compose`
- Calendar read: `https://www.googleapis.com/auth/calendar.events.readonly`
- Calendar actions: `https://www.googleapis.com/auth/calendar.events`
- Drive selected files: `https://www.googleapis.com/auth/drive.file`

Orkestr must not request broad Drive scopes for this flow. Drive access is
limited to files selected or created through Orkestr by `drive.file`.

## Verification Demo Checklist

Use generic demo data only.

- Show the WhatsApp `/connect google` command and the one-time link reply.
- Show the capability disclosure page before Google OAuth.
- Select a narrow set of capabilities, then complete Google OAuth.
- Show the WhatsApp confirmation listing enabled capabilities.
- Demonstrate a Gmail read action.
- Demonstrate a Gmail label/archive/read-unread action if `gmail.modify` was
  selected.
- Demonstrate draft creation or approved send if Gmail send/drafts was
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
