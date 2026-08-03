# Google Workspace OAuth Verification Prep

Orkestr supports a WhatsApp-first Google Workspace connection flow for
user-owned accounts. The parent Orkestr install owns the Google OAuth client,
but each user's grant and token are scoped to that user.

## User Flow

1. The user sends `/connect google` in their WhatsApp-bound Orkestr chat.
2. Orkestr replies with a one-time `/connect/google` link.
3. Orkestr stores the smallest capability set required for that requested
   action on the server. The browser page displays that set read-only.
4. Google is the only account and permission consent screen. The browser page
   cannot add, remove, or broaden scopes.
5. If Google grants only some scopes, Orkestr stores and exposes only the
   granted capabilities.
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

Keep restricted scopes action-scoped. Do not make them a silent default or a
client-controlled checkbox selection.

## Expanded Verification Contract

The current expanded verification request is deliberately narrower than the
full connector feature set. Its deployed allowlist, Google Cloud Console scope
list, OAuth consent screen, demo recording, reviewer environment, and written
justifications must all contain exactly these optional capabilities:

```dotenv
ORKESTR_GOOGLE_OAUTH_ALLOWED_CAPABILITIES=gmail_send,gmail_read,gmail_drafts,calendar_read,calendar_actions
```

That produces this exact OAuth scope set, in addition to the three base identity
scopes listed below:

- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/calendar.events.readonly`
- `https://www.googleapis.com/auth/calendar.events.owned`

Do not submit `gmail.modify`, `drive.file`, `calendar.events`, or any broader
Google scope in this review. Those are supported as separate optional product
capabilities and require their own justification and verification evidence
before they are enabled for the verified production OAuth client.

Scope justifications for the submission:

| Scope | User-visible action | Why the scope is needed |
| --- | --- | --- |
| `gmail.send` | Send an email the user requested or approved | Sends the exact recipient, subject, body, and attachments selected by the user. It does not read mailbox history. |
| `gmail.readonly` | Search, inspect, and summarize mail signals the user asks Orkestr to read | Retrieves matching message metadata and content without changing messages, labels, or mailbox settings. |
| `gmail.compose` | Create, revise, and send a user-approved Gmail draft | Creates a draft before sending it and stores only the draft data and identifier required to continue that user workflow. |
| `calendar.events.readonly` | List events and availability for a date range the user asks to inspect | Reads event details on calendars the user can access without changing any event. |
| `calendar.events.owned` | Create, update, and delete a user-approved event on a calendar the user owns | Limits event changes to calendars owned by the connected account; Orkestr shows or asks for the effective event details before the action. |

## Google Cloud Console Values

Use a dedicated Google Cloud project that contains only Orkestr OAuth clients.
Do not share the verification project with unrelated apps: Google's review
materials must account for every OAuth client registered in that project.

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

Keep the verified production client as the default. Additional staging,
testing, or customer-specific clients must be selected explicitly and are never
used as an automatic fallback:

```dotenv
ORKESTR_GOOGLE_OAUTH_DEFAULT_APP=production
ORKESTR_GOOGLE_OAUTH_APPS_JSON={"staging":{"clientId":"...","clientSecret":"...","redirectUri":"https://connect.example.test/oauth/gmail/callback","approvedTesters":["tester@example.test"]}}
```

Call `orkestr_auth` with `oauth_app: "staging"` only when the user asks for
that profile. Omit `oauth_app` to use `production`. Orkestr stores the selected
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

Calendar read and Calendar actions are separate user-facing capabilities. When
both are selected, Orkestr requests both scopes: `calendar.events.readonly`
permits read-only availability across calendars the user can access, while
`calendar.events.owned` limits edits to calendars the user owns. Orkestr does
not suppress either selected capability while constructing the OAuth request.
Existing grants using the superseded broad Calendar action scope must be
re-authorized before Calendar actions are available under this narrow contract.
- Drive selected files: `https://www.googleapis.com/auth/drive.file`

Orkestr must not request broad Drive scopes for this flow. Drive access is
limited to files selected or created through Orkestr by `drive.file`.

## Isolated Reviewer Environment

Create the reviewer environment outside this public repository. It is a
disposable, synthetic-data installation used only for Google verification. It
must not be the production Orkestr home, a personal deployment, or a tenant
broker instance.

1. Create one dedicated Orkestr review user and one dedicated Google test
   account containing only synthetic messages, drafts, and calendar events.
   Do not use a customer, employee, or personal mailbox as reviewer evidence.
2. Use a fresh `ORKESTR_HOME`, database, connector encryption key, and browser
   profile. Do not mount an existing overlay, WhatsApp session, desktop, token
   directory, or workspace into this environment.
3. Enable only the five capabilities in the expanded verification contract.
   Confirm the Google Cloud Console data-access list is the same scope list.
4. Keep normal Orkestr pairing enabled. The stable reviewer URL requires the
   separate review password, then creates a normal Orkestr browser session for
   the dedicated reviewer user. It opens a dedicated **Client workspace
   review** page that first shows normal Orkestr chat and thread timers. The
   reviewer asks the chat to create a Google connection link, which opens the
   real **Connectors > Gmail** connection flow. After consent, the workspace
   shows that the selected capabilities are available to chat and timers, and
   links to real review actions: read its
   self-addressed review test message, create a self-addressed draft, send a self-addressed test
   message, list its reviewer-created test events, and create a no-guest test event. The
   reviewer link requests the complete submitted scope set and displays it
   read-only before Google presents its consent screen. This is safe only
   because the entire VM is isolated and contains no production users, threads,
   WhatsApp accounts, Raw sessions, desktops, browser profiles, or unrelated
   connector data.
5. Give the reviewer the stable environment URL, review password, and
   dedicated test-account sign-in instructions only through the existing Google
   review email thread. Never commit credentials, session material, or test
   data to this repository.
6. After approval or expiry, revoke the test Google grant, delete its synthetic
   data and Orkestr home, rotate the review-link secret, and disable the review
   environment.

The reviewer environment is intentionally disabled by default. A private review
environment must set all of the following values, with a high-entropy secret
of at least 32 characters stored only in its service environment:

```dotenv
ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED=1
ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET=<high-entropy-secret>
ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL=https://review.example.test
ORKESTR_GOOGLE_WORKSPACE_REVIEW_ENV_TTL_MINUTES=240
ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD=<high-entropy-review-password>
ORKESTR_GOOGLE_WORKSPACE_REVIEW_USER_ID=google-reviewer
ORKESTR_GOOGLE_WORKSPACE_REVIEW_THREAD_ID=google-oauth-reviewer
```

Generate it only on that isolated instance, with a dedicated reviewer thread:

```bash
orkestr connect google --review-environment --thread google-oauth-reviewer --json
```

The generated URL is stable. A reviewer enters the separately supplied password,
which creates Orkestr's normal HttpOnly browser session for this disposable VM
and opens **Client workspace review**. The reviewer first sees normal chat and
thread timers, then asks the chat to create the real Google connection link.
The reviewer-only
connect request contains the complete submitted scope set and cannot be edited
in Orkestr. After the Google callback, Orkestr returns the reviewer to the
capabilities page, where each requested scope has a real, bounded test action.

Use a high-entropy review password, send it only in the Google verification
thread, and rotate `ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET` after the
review. Rotating that secret revokes every reviewer browser session and any
outstanding internal OAuth ticket.

Provision this environment as a dedicated tenant VM slice with no WhatsApp,
desktop, or CRM connector. The stable external reviewer hostname belongs at the
reverse proxy, while the VM receives a fresh Orkestr home and the reviewer-only
environment variables above. First inspect the plan, then explicitly apply it:

```bash
orkestr vm-slice create google-reviewer \
  --id google-oauth-reviewer \
  --name "Google OAuth reviewer" \
  --no-control-plane --no-whatsapp --no-linkedin --no-oxrm \
  --create-only
orkestr vm-slice provision google-oauth-reviewer
orkestr vm-slice provision google-oauth-reviewer --execute
```

Add the exact reviewer callback URI configured by that deployment to the same
Google OAuth client before opening the link. Do not reuse a production callback
or point the reviewer hostname at a production Orkestr home.

After the review, inspect the destruction plan and execute it only after the
reviewer link and Google grant have been revoked:

```bash
orkestr vm-slice destroy google-oauth-reviewer
orkestr vm-slice destroy google-oauth-reviewer --execute
```

The execute step deletes only that registered slice's KubeVirt VM, service,
cloud-init secret, DataVolume, and root PVC, then marks its VM and slice records
deleted. It does not delete a shared namespace or any other tenant. This is the
required removal step for local OAuth state; do not substitute the registry-only
delete endpoint for it.

The reviewer uses the product rather than a separate audit form. The dedicated
VM can create test threads and use any normal Orkestr surface, but its data
boundary is the VM itself: only the synthetic reviewer user and test Google
account exist there. Reviewer links cannot be generated for brokered tenant
connections. A missing, altered, or disabled password configuration does not
fall back to broad access or disable pairing elsewhere.

## Verification Demo Checklist

Use generic demo data only.

- Open the stable isolated reviewer URL, enter the supplied Orkestr review
  password, and show normal **Client workspace review** chat and thread timers.
- Briefly show the public `https://orkestr.de/` homepage with the app name,
  purpose, and privacy/terms links.
- Ask the chat to create a Google connection link, then start Google connection
  from **Connectors > Gmail**. Show the read-only
  requested-capabilities page, the Google-data access, sharing, protection,
  retention, and deletion disclosures, and then continue to Google.
- Complete Google OAuth with only the five capabilities in the expanded
  verification contract. Expand every requested Google consent-screen scope in
  the same recording; do not cut from one authorization request to another.
- Return to Orkestr and show the connected Google account and enabled
  capabilities.
- Demonstrate a user-approved Gmail send action.
- Demonstrate a Gmail read action only if `gmail.readonly` is selected.
- Demonstrate draft creation or draft sending only if `gmail.compose` was
  selected.
- Demonstrate Calendar event listing if Calendar read was selected.
- Demonstrate creating, updating, or deleting a test Calendar event if Calendar
  actions was selected.
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
- The connect page requests only the capability set fixed in its server-side
  one-time OAuth record. It displays that set read-only, ignores client-supplied
  scope changes, and records the requested capabilities and privacy-policy
  version in the OAuth state.
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
- The dedicated reviewer environment satisfies the isolation checklist above,
  the environment link has been tested without disabling pairing on normal
  routes, and its OAuth callback returns to that environment.
- The privacy policy contains an affirmative Google Limited Use statement and
  states that Google Workspace data is not used to develop, improve, or train
  generalized or non-personalized AI or machine-learning models.

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
was verified, and the OAuth request was resubmitted. Include the unlisted demo
video URL, reviewer navigation steps, and temporary synthetic-account
credentials only in that existing thread. Do not open a new email thread.

## Submission Package

Do this only after the live reviewer environment has passed the release gate.

1. In Google Cloud Console, make the submitted scope list exactly match the
   five-scope expanded contract above. Remove every unreviewed scope.
2. Verify the same allowlist is deployed to the isolated reviewer environment.
3. Record the checklist above as an unlisted YouTube video. The complete Google
   consent screen and every scope must be visible.
4. Put the stable reviewer URL, password, and any synthetic-account details in
   the existing Google review email thread. Do not put them in the video,
   repository, issue tracker, or public documentation.
5. Reply in that thread with the scope table above, the unlisted video, these
   navigation steps, and the three privacy anchors.

Reviewer navigation steps for the reply:

1. Open the supplied reviewer URL and enter the supplied Orkestr password.
2. On **Client workspace review**, ask the chat to create a Google connection
   link, then choose **Continue to Google**.
3. Sign in with the supplied synthetic Google account or the review account.
4. Review and accept the Google consent screen.
5. Return to **Client workspace review**, where the approved capabilities are
   available to chat and timers, then open the five Gmail and Calendar
   verification actions. The draft and sent message are addressed
   only to the connected review account; the created calendar event has no
   guests.
