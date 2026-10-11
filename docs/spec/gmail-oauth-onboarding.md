# Gmail OAuth onboarding: two deployment modes

Status: architecture proposal. This document describes target behavior and
acceptance criteria; it does not claim that the current implementation meets
them. It covers Gmail only. LinkedIn remains a managed desktop workflow.

## Current implementation audit

| Area | Present | Gap to close |
| --- | --- | --- |
| OAuth app setup | Setup accepts a Google web client ID, secret, and callback URI; the server also accepts operator environment and named app profiles. | Show the self-hosted and Orkestr-hosted paths explicitly. Explain Google's testing, production, and verification states before sign-in. A hosted tenant must not edit the operator's app credentials. |
| Consent | Server-issued connect requests and one-time start intents bind parameters; callback state is consumed with expiry, host, and principal checks. The default production capability is Gmail send. | Make feature intent and app eligibility the source of the requested scope set for every entrypoint. Reject unknown or unverified grants rather than inferring granted scopes from the request. |
| Tokens | Per-connection access and refresh tokens are encrypted with AES-256-GCM under `ORKESTR_HOME`; non-admin users have user paths, and tenant VMs use their own instance path. Legacy token migration and account selection exist. | Define key backup/rotation and tenant deletion behavior. Treat the OAuth client secret as sensitive local configuration; it is currently a permission-limited secret JSON record, not an encrypted connector token. |
| Renewal | Expiry triggers refresh; Gmail reads retry once after 401; terminal auth errors become reconnect-required. Brokered tenants ask the parent OAuth app to refresh. | Preserve the issuing app ID, verify the returned scope set, serialize concurrent refresh, and keep refresh credentials out of response bodies and diagnostic logs where possible. |
| Revocation | Disconnect calls Google's revoke endpoint, then deletes the local connection. A transient revoke failure retains the token for retry. | Name this action “Revoke access”; expose retryable revocation status, stop all local use immediately, and delete local data only after success or a clearly labeled local-forget choice. |
| Agent actions | Read/search, draft, send, and message-modify functions exist. Write helpers check stored capability names. Action registry labels send as requiring explicit approval. | Enforce read/draft/send permissions at every server entrypoint. Approval metadata and model instructions alone are not an authorization gate. The `gmail.compose` grant can send a draft, so draft permission needs an independent application-level send fence. |
| UI | Setup has a basic bring-your-own-app form; Connectors lists accounts and has a connect/reconnect control and a “Delete” action. | Provide one coherent connect, status, reconnect, revoke flow with per-account permissions, app mode, testing expiry, and clear recovery actions. |

## Contract shared by both modes

One Gmail service interface serves the UI, chat agent, timers, and HTTP routes:
`connect(intent)`, `status(account)`, `reconnect(account, intent)`,
`revoke(account)`, `search`, `read`, `createDraft`, `sendDraft`, and `sendMessage`.
The interface resolves an owner and a stable connection ID before any provider
call. It never selects another account after an explicit account lookup fails.
Provider-specific credential handling sits behind this interface.

The authorization decision for an action is the intersection of four sets:
deployment-approved features, the OAuth app's approved features, scopes
actually granted to this connection, and the account owner's enabled Orkestr
permissions. An absent, stale, or unknown scope result grants nothing. Keep
`gmail.modify` outside this read/draft/send contract; message modification is
a separate capability and review decision.

| Orkestr permission | Google scope requested for that feature | Runtime rule |
| --- | --- | --- |
| Read | `gmail.readonly` | Search, fetch, and notifications require an enabled Read permission and a verified matching grant. |
| Draft | `gmail.compose` | Creating/updating drafts requires Draft. This scope also permits sending at Google, so Orkestr must fence all send routes independently. |
| Send | `gmail.send` | Sending a new message requires Send plus a one-use approval for the exact message. Sending an existing draft requires both Draft and Send at Orkestr, a provider scope accepted by Google's draft-send method, and the same approval gate. |

Google classifies `gmail.send` as **sensitive** and `gmail.readonly` and
`gmail.compose` as **restricted**. Publishing a public app with restricted
access may require Google verification and an annual third-party security
assessment when restricted data passes through a third-party server. The
application must never label a scope “approved” solely because it was listed
in Orkestr configuration. See [Google's Gmail scope table](https://developers.google.com/workspace/gmail/api/auth/scopes)
and [restricted-scope verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

### Lifecycle and action gates

1. **Connect:** The user chooses an action such as Read, Draft, or Send. Orkestr
   issues a one-time, user/session/host-bound intent and displays the fixed
   scopes, data use, OAuth app identity, and account chooser. Google consent is
   the provider grant. Callback validates state, exact redirect, issuer/app,
   account identity, and granted scopes before activating the connection.
2. **Status:** Return app mode, account alias, granted and enabled permissions,
   health (`ready`, `partial`, `degraded`, `reconnect_required`, `revoking`, or
   `revoked`), last checked time, and next action. Never return a token, client
   secret, full error body, or raw mailbox content. Status must distinguish a
   testing-mode grant with expected expiry from an invalid grant.
3. **Reconnect:** Bind the selected connection and issuing OAuth app. Request
   only the newly needed scopes, then replace that connection atomically after
   identity and scope checks. A failed reconnect leaves the old connection
   recorded and cannot broaden its effective permissions.
4. **Revoke:** Fence reads and writes immediately, attempt Google revocation,
   then remove local token, account defaults, watcher references, and pending
   send approvals. On provider failure, keep an encrypted retry record with no
   usable action authority and show a retry state. A local-only forget path
   needs an explicit label because it cannot prove Google revocation.
5. **Send:** The server creates a preview of the effective account, To/Cc/Bcc,
   subject, body, and attachment hashes. The account owner approves that exact
   preview through a trusted Orkestr action. A one-use, short-lived approval
   binds owner, tenant, thread, account, message digest, and idempotency key.
   Revalidate permissions and the digest immediately before the provider call;
   any change requires a new approval. For a draft, fetch and compare its
   current contents before send and reject missing or changed drafts. Record
   the result so retries cannot create duplicate mail. Timers or automated
   sends require a separate, explicit owner authorization policy with bounds;
   a model prompt never supplies that authorization.

Apply these guards in the Gmail service itself and at all public HTTP and agent
entrypoints. No alternate path, including review actions, legacy routes, or
operator notification helpers, may bypass the same permission decision.

## Mode 1: self-hosted Docker

The install starts without a Google account. In Setup, a local owner chooses
**Use my Google OAuth app**, opens their own Google Cloud project, enables the
Gmail API, configures the consent screen and audience, creates a **Web
application** client, and registers the exact callback URI that Setup shows.
The ID and secret are submitted through the authenticated setup API and stay
in the owner's mounted `/data` volume (`ORKESTR_HOME`), outside the repository.
The user grant and encryption key also stay in that volume. Document that a
backup must preserve the token records and their key together, and protect the
Docker volume from other host users. Do not copy these values into a hosted
broker, logs, analytics, or a public example. A production public callback
needs a domain the owner controls and HTTPS; show a local development callback
only when Google accepts that exact configured URI.

The wizard must explain the actual Google choices before asking for a secret:

- An **External / Testing** app is limited to listed test users (up to 100).
  For Gmail scopes, test authorizations and offline refresh tokens expire after
  seven days; reconnecting periodically is expected. The exception for only
  basic profile/identity scopes does not apply to Gmail access.
- Switching to **In production** removes the Testing-only seven-day rule but
  does **not** itself verify sensitive or restricted scopes. An unverified app
  can show warnings and has a lifetime new-user cap. Public distribution using
  sensitive or restricted scopes requires the relevant Google review; a
  personal or internal use exception is conditional, not an automatic label
  granted by Orkestr.
- Read and Draft are restricted scopes. The owner must consider Google's
  verification and security-assessment requirements before distributing an
  app that handles other users' restricted Gmail data.

These constraints come from [Google audience/testing guidance](https://support.google.com/cloud/answer/15549945),
[OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies),
and [production readiness guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).
The callback URI must exactly match the Google client setting, including
scheme, host, path, and trailing slash; see [Google's web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server).

## Mode 2: Orkestr-hosted

The operator's existing Google OAuth application and client secret live in a
private operator configuration or `ORKESTR_OVERLAY_DIR`, never in the OSS image
or tenant setup form. The operator records, per OAuth app profile, which scopes
Google has actually approved for production. Until approval is established,
the production allowlist remains at its currently documented Gmail-send
profile; Read and Draft stay unavailable. A separate test app/profile is used
for restricted feature development.

Each hosted tenant has an immutable broker instance ID and isolated runtime
storage. The broker starts OAuth only for an authenticated, bound tenant-owner
intent, exchanges the code with the matching operator app, verifies account
and scopes, and transfers the grant to that tenant over an authenticated,
encrypted channel. Tenant token records and connection choices remain in that
tenant's volume. The parent holds the client secret and can perform a narrowly
authorized refresh, but must not persist a tenant's refresh token in shared
operator state. Bind refresh and revoke requests to tenant ID, connection ID,
issuing app ID, and grant identity; return the minimum token material through
the protected tenant channel. Never let one tenant select another tenant's
account, OAuth state, token, or app profile.

Hosted and self-hosted modes use the same Gmail service interface and status
schema. Only app configuration, callback routing, and refresh transport differ.
LinkedIn remains a leased managed desktop and is outside this work.

## Acceptance tests for implementation PRs

All automated cases use fake app IDs, accounts, tokens, and a stub Google HTTP
server. No live Gmail or production OAuth credentials are required.

1. **Self-hosted setup:** Fresh Docker volume shows the guide, accepts an
   authenticated owner's fake web client, saves it only under the mounted
   volume, survives restart, and never echoes the secret through status/logs.
   Missing client, incorrect callback, or untrusted setup caller fails before
   any OAuth state is written.
2. **Google lifecycle copy:** UI distinguishes Testing from In production and
   unverified from verified. It states the test-user and seven-day limits for
   Gmail scopes and does not promise that production status grants approval.
3. **Hosted app boundary:** Tenant UI cannot submit/replace the operator client
   secret or choose an unapproved app profile. A synthetic tenant A intent or
   grant cannot be replayed for tenant B, including callback, refresh, status,
   revoke, or agent actions.
4. **Fixed consent:** Server-issued intent fixes owner, session, host, tenant,
   account connection, app ID, and feature set. Changed fields, expired/replayed
   state, wrong redirect host, and concurrent reuse fail before token exchange.
5. **Verified grant:** Partial grant exposes only matching capabilities.
   Missing or untrusted provider scope evidence exposes none. App allowlist,
   provider grant, and owner permission are intersected on every call, even
   after an allowlist is narrowed.
6. **Local tokens:** Access/refresh token files contain encrypted envelopes;
   permissions and tenant paths are correct. Wrong key fails closed. Migration,
   backup/restore with the correct key, and key rotation preserve the account
   without exposing plaintext. Client secret is protected separately.
7. **Refresh/reconnect:** Expiry and one 401 refresh once, preserve app ID and
   refresh token, update scopes from the provider, and serialize concurrent
   refresh. `invalid_grant` moves to reconnect-required without repeated calls.
   A transient error is degraded and keeps the encrypted record. Reconnecting
   one account cannot alter another or activate a different Google identity.
8. **Read/Draft/Send matrix:** Each permission succeeds only with its owner
   setting and verified scope. Read-only cannot draft or send; draft-only
   cannot send despite `gmail.compose` being send-capable at Google; send-only
   cannot read or draft. Every direct API, agent, timer, and review path agrees.
9. **Send approval:** No Gmail send request occurs without a current one-use
   approval of the exact effective account, recipients, subject, body, and
   attachment hashes. Changed or stale drafts, changed recipients, replayed
   approval, cross-thread/tenant use, missing Send permission, and duplicate
   retries all fail before a second provider call.
10. **Revoke:** A successful provider revoke fences operations and removes the
    selected local grant and dependent defaults/watchers/approvals. A 5xx
    response leaves a retryable encrypted record that cannot be used. Status
    accurately distinguishes provider revocation from local-only forgetting.
11. **Interface parity:** The same fake Gmail scenario gives the same public
    status and agent results in self-hosted and hosted modes. Mode-specific
    credentials and broker details never appear in agent results.

An attended verification with a dedicated synthetic Google account is an
optional release check only after the relevant OAuth app and scopes are
approved. It must use its own isolated environment, not a personal mailbox.

## Scoped implementation PR sequence

1. **Setup and policy:** Mode-aware setup guide, capability-specific connect
   intents, status/reconnect/revoke wording, and Google lifecycle copy. Touch
   Gmail UI, controller, and public docs only.
2. **Gmail authorization core:** Centralize the four-way capability decision,
   fail-closed scope evidence, account identity, refresh serialization,
   encryption/key lifecycle, and revoke fencing in connector modules. Route
   all Gmail reads and writes through it.
3. **Send gate:** Add server-side preview, one-use approval, draft comparison,
   idempotent send record, and bounded automation policy. Update agent and
   HTTP adapters to require it; add the authorization matrix tests.
4. **Hosted broker hardening:** Bind and minimize grant, refresh, and revoke
   exchanges between operator broker and tenant runtime. Add cross-tenant
   negative tests and verify the operator-approved production scope set.

These PRs do not modify WhatsApp transport or LinkedIn connector code.
