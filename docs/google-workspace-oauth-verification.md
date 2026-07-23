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

The production runtime enforces this with:

```dotenv
ORKESTR_GOOGLE_OAUTH_ALLOWED_CAPABILITIES=gmail_send
```

The connect page and the OAuth start endpoint both apply the allowlist. A
manually constructed URL cannot request a capability that is not approved for
the deployment. Use a separate testing client and an explicit allowlist when
developing broader capabilities; do not broaden the verified production client
before Google approves the additional scopes.

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

## Multiple OAuth apps

Keep the verified production client as the default. Additional testing or
customer-specific clients must be selected explicitly and are never used as an
automatic fallback:

```dotenv
ORKESTR_GOOGLE_OAUTH_DEFAULT_APP=orkestr-de
ORKESTR_GOOGLE_OAUTH_APPS_JSON={"otcan-claw":{"clientId":"...","clientSecret":"...","redirectUri":"https://connect.orkestr.de/oauth/gmail/callback","approvedTesters":["can@mayamilk.com"]}}
```

Call `orkestr_auth` with `oauth_app: "otcan-claw"` only when the user asks for
that profile. Omit `oauth_app` to use `orkestr-de`. Orkestr stores the selected
profile id with the connection so callback exchange and refresh always use the
same OAuth client. Testing-mode Google refresh tokens for Gmail or Calendar
scopes expire after seven days.

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
- Calendar actions on calendars the user owns: `https://www.googleapis.com/auth/calendar.events.owned`

`calendar.events.owned` also permits reading events on calendars the user
owns. When Calendar actions are selected, Orkestr therefore does not request
the redundant `calendar.events.readonly` scope. Existing grants that used
`calendar.events` remain recognized for backward compatibility.
- Drive selected files: `https://www.googleapis.com/auth/drive.file`

Orkestr must not request broad Drive scopes for this flow. Drive access is
limited to files selected or created through Orkestr by `drive.file`.

## Verification Demo Checklist

Use generic demo data only.

- Show the WhatsApp `/connect google` command and the one-time link reply.
- Briefly show the public `https://orkestr.de/` homepage with the app name,
  purpose, and privacy/terms links.
- Show the capability disclosure page before Google OAuth.
- Show the Google-data access, sharing, protection, retention, and deletion
  disclosures immediately before the affirmative consent control.
- Select only the capabilities submitted for the current verification demo,
  then complete Google OAuth.
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

## Privacy And Security Release Gate

Do not submit or reply to a Google verification review until all of these are
true on the live production deployment:

- `https://orkestr.de/privacy` is public without login and exposes stable
  anchors for Google data access, sharing, storage, protection, Limited Use,
  and deletion.
- The connect page defaults to Gmail send, allows only deployment-approved
  capabilities, and records the selected capabilities, privacy policy version,
  and affirmative consent time in the one-time OAuth state.
- Google access and refresh tokens are AES-256-GCM encrypted on disk. The
  production `ORKESTR_CONNECTOR_ENCRYPTION_KEY` is stored in the service
  environment outside `ORKESTR_HOME`.
- Legacy plaintext Gmail token records migrate to encrypted envelopes when
  first read and are never returned through public APIs or event logs.
- Disconnect revokes the Google credential before deleting the local encrypted
  record. A temporary Google revocation failure leaves the record available for
  a safe retry instead of reporting a false disconnect.
- The live homepage, `/about`, privacy policy, OAuth consent screen, deployment
  capability allowlist, submitted scopes, scope justification, and demo video
  all describe the same production behavior.

## Gmail Signal Notifications

The initial notification implementation is intentionally operationally simple:

1. A user grants Gmail read and creates a narrow Gmail query watcher.
2. Orkestr persists the watcher and polls it on the configured cadence.
3. Gmail message ids are deduplicated before delivery to the selected thread.
4. The Connectors page reports the last check, last delivery, result count, and
   last error, and offers an explicit **Check now** control.
5. A paired browser may opt into local Notification API alerts. Browser
   permission is never requested automatically, and notification previews do
   not contain message bodies.

This is not Gmail push delivery. A future Pub/Sub implementation must preserve
the same tenant ownership, query filtering, deduplication, audit, renewal, and
fallback-polling guarantees before it replaces polling.

After the corrected policy is deployed and the Cloud Console request is
resubmitted, reply in Google's existing review email thread. Link directly to:

- `https://orkestr.de/privacy#google-data-access`
- `https://orkestr.de/privacy#google-data-sharing`
- `https://orkestr.de/privacy#google-data-protection`

The reply should confirm that the policy was updated, the production behavior
was verified, and the OAuth request was resubmitted. Do not open a new email
thread.
