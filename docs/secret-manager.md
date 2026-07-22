# Secret Manager

Orkestr's first-class secret manager is the secure-input system. It stores
secret values under `ORKESTR_HOME` and exposes only metadata through APIs, CLI
commands, and the setup UI.

## Contract

- Secret values are written through `POST /api/secure-input/secrets`, the setup
  Secrets panel, or `orkestr secret set`.
- Secret values are encrypted with AES-256-GCM before storage.
- The encryption key is loaded from `ORKESTR_SECURE_INPUT_KEY` or
  `ORKESTR_SECRET_KEY`; if neither exists, Orkestr creates
  `ORKESTR_HOME/secrets/secure-input.key` with private file permissions.
- Public responses return metadata only: name, handle, scope, owner, status,
  timestamps, usage labels, and fingerprint.
- Secret handles are stable references:
  - `secret://user/<user-id>/<name>`
  - `secret://global/<name>`
- Global secrets are admin-only. User secrets are available to the owning user
  and admins, subject to Orkestr policy.
- Missing secret references create metadata-only secure-input requests so setup
  can show what needs to be configured without exposing values.

## Storage

Secure-input stores data below the protected Orkestr data home:

- global secrets: `ORKESTR_HOME/secrets/secure-input-global.json`
- user secrets: `ORKESTR_HOME/users/<user-id>/secrets/secure-input.json`
- missing requests: `ORKESTR_HOME/secrets/secure-input-requests.json`
- generated key: `ORKESTR_HOME/secrets/secure-input.key`

These files must never be committed, copied into public diagnostics, mirrored to
Codex context, or shown in browser screenshots.

## Migration Direction

New connector and runtime code should request secrets by handle and resolve them
through `packages/core/src/secure-secrets.js`.

Existing env or connector-specific secret stores can remain during migration,
but new work should avoid adding more ad hoc secret files. Migration tools must
support dry-run output that reports only names, scopes, and status. They must
never print secret values.

Google Workspace connector tokens use the same security standard through an
encrypted connector-record envelope. Access and refresh tokens are encrypted
with AES-256-GCM before they are written to the user's connector directory.
Production installs generate `ORKESTR_CONNECTOR_ENCRYPTION_KEY` in the protected
service environment outside `ORKESTR_HOME`; local development falls back to a
private key file under `ORKESTR_HOME/secrets`. Existing plaintext Gmail token
records are rewritten as encrypted records on first read.

The first migration utility covers known environment secrets:

```bash
npm run secrets:migrate-env -- --env-file /path/to/private.env
npm run secrets:migrate-env -- --env-file /path/to/private.env --write
npm run secrets:migrate-env -- --env-file /path/to/private.env --write --user alice
```

Dry-run is the default. `--write` is required before anything is stored in
secure-input.

## Verification

The boundary is covered by:

- `test/secure-secrets.test.js`
- `test/secure-secrets-migrate-env.test.js`
- CLI tests for `orkestr secret`
- setup UI static checks for the secure-input controller and panel
- `npm run oss:boundary-check`
- `npm run launch:check`
