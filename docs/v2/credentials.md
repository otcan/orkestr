# V2 Credentials page (ORK-826)

The owner's passwords, tokens and API keys, and which chat used each one and
when, on one page: `#credentials`, opened from Orkestr settings. It replaces
the vault section that used to sit there.

Rules that hold throughout: a value is typed once and sent once; it is never
listed, logged or returned by these routes. Errors carry fixed codes.

## 1. What the owner sees

One row per credential:

| Column | Content |
| --- | --- |
| Credential | Its name and site (the bare domain). |
| Type | Password, Token or API key. |
| Used by | The chats that may use it, by name, and "Your desks (automatic sign-in)" when the owner's own desks may sign in with it. |
| Last used | When, and by which chat. |
| Status | OK, Failed last sign-in, Needs 2FA code, or Never used, with the last sign-in's outcome in plain words. |

Search covers name, site, type and chat names, plus a type filter. "Add
credential" opens a small form whose fields follow the type (username and
password, a token, or an API key, each with notes). Allowed chats are picked
by name. An edit lists what will change and is saved only after the owner
confirms; a delete asks first. Showing a value is a separate, recorded
action (below).

## 2. Stores

The page is one API (`/api/v2/credentials`) over a store chosen at startup:

| Store | Selected by | Chats | Showing a value |
| --- | --- | --- | --- |
| The built-in vault (`vault.md`) | Default, no configuration | V1 thread grants | This browser opens the sealed login with its own key; the vault records `owner_reveal` |
| [OpenBao](https://openbao.org) KV v2 | `credentials-backend.json` | V2 conversation ids and `owner-desks` | A link to the item in OpenBao's own UI, where the owner signs in and OpenBao records the read |

The answer's `capabilities` tell the page what the store allows
(`grant_ids`, `owner_desks_editable`, `site_with_value`, `value_replace`,
`reveal`).

### OpenBao configuration

`<ORKESTR_V2_HOME>/credentials-backend.json`, or the file named by
`ORKESTR_V2_CREDENTIALS_CONFIG` (for a systemd credential:
`%d/credentials-backend.json`). It holds an AppRole secret, so it must be a
regular file owned by root or the server's user, mode 0600 or 0400. A refused
file never falls back to the built-in vault: the page says the configuration
was refused.

```json
{"format": "orkestr-v2-credentials-backend-v1", "backend": "openbao",
 "address": "http://127.0.0.1:8200", "mount": "orkestr", "prefix": "creds",
 "role_id": "<role id>", "secret_id": "<secret id>",
 "catalog": "/var/lib/example/credentials-catalog.json",
 "usage_summary": "/var/lib/example/credentials-usage.json",
 "reveal_url": "https://bao.example.invalid/ui/vault/secrets/orkestr/kv/creds%2F{id}"}
```

- `address` must be plain HTTP on a loopback address: the token never crosses
  a network in the clear.
- The AppRole needs, on `<mount>`: `create`, `update`, `patch` on
  `data/<prefix>/*`; `create`, `read`, `update`, `patch`, `delete`, `list` on
  `metadata/<prefix>/*`; `update` on `delete/<prefix>/*`. It should **not**
  have `read` on `data/`: the server never reads a value.
- Each credential is `<mount>/data/<prefix>/<slug>` with custom metadata
  `type`, `site`, `label` and `allowed` (comma-separated conversation ids
  and/or `owner-desks`; KV v2 limits a value to 512 characters, so at most 13
  chats). Writes from the page set `source=orkestr-page` and keep other keys
  (for example an import's `legacy_id`). Values go to `username`, `password`,
  `token`, `api_key`, `url` and `notes`.
- Adding writes the metadata first, then the value with check-and-set 0.
  Replacing a value is a merge patch with check-and-set on the current
  version, so fields left empty keep their stored value. Deleting
  soft-deletes the current version (OpenBao's `undelete` restores it).
- Every request carries `X-Orkestr-Tool: credentials-page` for the store's
  audit log.

### Catalog and usage summary

Two value-free files, written by a root job that follows the store's audit
log (the log itself stays with root):

- **`catalog`** (`orkestr-credentials-catalog-v1`): every live credential's
  metadata. With it the page lists a large store without reading every
  credential through the API on each load (each read is an audit line). Its
  own writes show at once, before the next catalog. Without a catalog newer
  than 15 minutes the server reads the store directly, at most 200
  credentials, and says the list is cut short.
- **`usage_summary`** (`orkestr-credentials-usage-v1`, default
  `<home>/credentials-usage.json`): per credential the last use (time and
  chat), uses per chat, and the last sign-in's result (`ok`, `failed`,
  `needs_2fa`) with its outcome code. Older than 10 minutes, the page says
  the usage columns may be behind. The built-in vault also reports its own
  `stored_login_read` events live.

Both files must be regular files owned by root or the server's user and not
writable by others; anything else is ignored.

## 3. Routes

All need the owner's password-signed-in browser session; a service session
is refused. Changes need Origin, Host and CSRF (the router's guard).

| Route | Purpose |
| --- | --- |
| `GET /api/v2/credentials` | Store, capabilities, rows with usage, `truncated`, `usage.stale`. |
| `POST /api/v2/credentials` | `{type, label, site, allowed, owner_desks, value: {...}}`; a password needs a site. |
| `PATCH /api/v2/credentials/{id}` | `{expected_revision, label?, site?, allowed?, owner_desks?}`. |
| `PUT /api/v2/credentials/{id}/value` | `{expected_revision, value: {...}}` (`site` too for the built-in vault). |
| `DELETE /api/v2/credentials/{id}?expected_revision=…` | Delete. |

A stale `expected_revision` answers 409 `credential_changed`. Store problems
answer 503 `credentials_backend_unavailable`, 429 `credentials_rate_limited`
or 502 `credentials_backend_refused`.

The server feature `credentials_v1` (in `/api/v2/health`) is required by the
web UI release, so a UI with this page is never paired with a server without
these routes.
