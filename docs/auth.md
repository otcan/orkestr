# Orkestr Auth

Orkestr OSS keeps authentication external. For a shared install, use Keycloak as
the identity provider and keep connector-specific identities under each user's
local Orkestr home directory.

## User Model

- Email is the unique login identifier.
- Phone number is required for login, but it is not unique. Shared family or
  company numbers are allowed.
- Orkestr does not store passwords.
- Orkestr stores local roles, status, limits, and contact fields in
  `users.json`.
- Provider-specific identities such as WhatsApp contacts, Gmail accounts,
  Outlook accounts, and browser profile state belong under
  `ORKESTR_HOME/users/<user-id>/`.

## Keycloak Policy

Configure Keycloak for passwordless login with both verification factors:

- email verification
- phone verification

The public OSS app exposes the desired policy through `/api/setup/status`:

- `auth.provider`
- `auth.keycloak`
- `auth.login`
- `auth.mail`
- `auth.storage`

Use environment variables to point Orkestr at the external identity provider:

```env
ORKESTR_AUTH_PROVIDER=keycloak
ORKESTR_KEYCLOAK_ISSUER=https://keycloak.example.com/realms/orkestr
ORKESTR_KEYCLOAK_CLIENT_ID=orkestr
```

Or use URL plus realm:

```env
ORKESTR_AUTH_PROVIDER=keycloak
ORKESTR_KEYCLOAK_URL=https://keycloak.example.com
ORKESTR_KEYCLOAK_REALM=orkestr
ORKESTR_KEYCLOAK_CLIENT_ID=orkestr
```

## Outlook Mail

Use Outlook SMTP in Keycloak for verification emails. Keep the SMTP secret in
the private host environment or Keycloak secret store, not in this repository.

```env
ORKESTR_OUTLOOK_SMTP_HOST=smtp.office365.com
ORKESTR_OUTLOOK_SMTP_USER=notifications@example.com
ORKESTR_OUTLOOK_SMTP_FROM=notifications@example.com
```

Orkestr reports whether Outlook mail delivery is configured, but it does not
expose SMTP passwords through the API or UI.
