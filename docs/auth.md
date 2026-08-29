# Orkestr Auth

Orkestr OSS keeps authentication external. For a shared install, use Keycloak as
the identity provider and keep connector-specific identities under each user's
local Orkestr home directory.

## User Model

- Keycloak subject (`sub`) is the durable login identity. Verified email
  establishes onboarding eligibility; it is not used as an immutable principal
  or copied into the Orkestr app session.
- Phone verification is optional and configured per Keycloak client. It is not
  required for the employee-facing app launcher by default.
- Orkestr does not store passwords.
- Orkestr stores local roles, status, limits, and contact fields in
  `users.json`.
- Provider-specific identities such as WhatsApp contacts, Gmail accounts,
  Outlook accounts, and browser profile state belong under
  `ORKESTR_HOME/users/<user-id>/`.

## Keycloak Policy

Configure Keycloak for verified-email login. The employee-facing app launcher
accepts either a passwordless email flow or the Google identity provider:

- email verification
- Google identity broker (optional)

Email magic-link login is an authenticator choice in Keycloak, not an Orkestr
mailbox flow. Pin and review the chosen Keycloak authenticator in the private
deployment. If a client needs phone verification, enable
`ORKESTR_AUTH_REQUIRE_PHONE_FACTOR=1` for that deployment/client policy.

The public OSS app exposes the desired policy through `/api/setup/status`:

- `auth.provider`
- `auth.keycloak`
- `auth.keycloak.oidcEnabled`
- `auth.login`
- `auth.mail`
- `auth.storage`

Use environment variables to point Orkestr at the external identity provider:

```env
ORKESTR_AUTH_PROVIDER=keycloak
ORKESTR_KEYCLOAK_ISSUER=https://keycloak.example.test/realms/orkestr
ORKESTR_KEYCLOAK_CLIENT_ID=orkestr
ORKESTR_KEYCLOAK_OIDC_ENABLED=1
ORKESTR_PUBLIC_APPS=1
```

Or use URL plus realm:

```env
ORKESTR_AUTH_PROVIDER=keycloak
ORKESTR_KEYCLOAK_URL=https://keycloak.example.test
ORKESTR_KEYCLOAK_REALM=orkestr
ORKESTR_KEYCLOAK_CLIENT_ID=orkestr
ORKESTR_KEYCLOAK_OIDC_ENABLED=1
ORKESTR_PUBLIC_APPS=1
```

When OIDC is enabled, Orkestr uses Authorization Code + PKCE at
`/auth/login` and `/auth/callback`. The callback must be an exact registered
Keycloak redirect URI on the public app origin, for example
`https://app.example.test/auth/callback`. The OIDC app session uses a host-only
`__Host-` cookie; it is intentionally separate from browser-pairing cookies.

## Outlook Mail

Use Outlook SMTP in Keycloak for verification emails. Keep the SMTP secret in
the private host environment or Keycloak secret store, not in this repository.
The same `ORKESTR_OUTLOOK_SMTP_*` variables are accepted as aliases for
Orkestr outbound SMTP notifications, including waitlist admin email.

```env
ORKESTR_OUTLOOK_SMTP_HOST=smtp.office365.com
ORKESTR_OUTLOOK_SMTP_USER=notifications@example.com
ORKESTR_OUTLOOK_SMTP_FROM=notifications@example.com
ORKESTR_WAITLIST_NOTIFY_EMAIL=admin@example.com
ORKESTR_WORKFLOW_PILOT_NOTIFY_EMAIL=pilot-review@example.com
```

Orkestr can also send outbound notifications through Microsoft Graph `sendMail`
when SMTP is not available. Keep token helpers and token files in the private
runtime environment. The command form is a JSON array so the app does not parse
shell syntax.

```env
ORKESTR_MAIL_PROVIDER=graph
ORKESTR_GRAPH_MAIL_FROM=hello@example.com
ORKESTR_GRAPH_MAIL_SENDER=sender@example.com
ORKESTR_GRAPH_MAIL_TOKEN_COMMAND_JSON=["/usr/local/bin/example-graph-token"]
ORKESTR_WAITLIST_NOTIFY_EMAIL=admin@example.com
ORKESTR_WORKFLOW_PILOT_NOTIFY_EMAIL=pilot-review@example.com
```

Orkestr reports whether Outlook or Graph mail delivery is configured, but it
does not expose SMTP passwords, access tokens, or token commands through the API
or UI.

Workflow Pilot submissions are stored separately from beta waitlist entries.
Set `ORKESTR_WORKFLOW_PILOT_NOTIFY_EMAIL` (or the plural comma-separated form)
to route commercial qualification notifications independently. When it is not
set, Orkestr falls back to the configured waitlist notification recipient so a
valid public submission is not silently orphaned. A qualified submission only
receives a scheduling link when `ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL` is set.
The public `/workflow` page uses the same setting only after a submitted map
passes the bounded-workflow qualification checks. If the value is missing or
unsafe, the inquiry is still stored and notified for manual review; the public
page never guesses or exposes a scheduling provider before qualification.
