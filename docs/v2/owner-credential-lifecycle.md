# Owner and automation credential lifecycle

Owner password management uses the V2 Argon2 credential store. It does not use
the V1 owner-login JSON file or its password-change implementation.

`POST /api/v2/browser/password` requires the current browser cookie, same-origin
CSRF protection and `{username,current_password,new_password}`. A write-locked
transaction rechecks the authenticated browser and verified old password hash,
replaces the hash, and revokes human browser sessions. Login session issuance
also rechecks the verified hash under its write lock, fencing a login that
verified the old password concurrently. The response requires a fresh sign-in.

## Automation migration before enabling rotation

Some compatibility consumers historically used the human browser-login endpoint.
These consumers must migrate before rotation is enabled. The new API is disabled
by default; the operator sets `ORKESTR_V2_PASSWORD_ROTATION_READY=1` only after
inventorying and migrating every unattended consumer. Browser security status
reports readiness and the password form remains disabled until then. This is a
technical migration gate, not a second owner approval.

For a sealed managed service, set the reviewed plan field
`password_rotation_ready: true`. It is pinned into `service.json` and forwarded
as the server flag; omitted plans remain disabled. An inherited shell or unit
environment cannot enable the feature inside a selected package.

Existing sessions are labelled `legacy` by migration 0086: their stored hashes
cannot reveal whether the original token had the browser prefix. Rotation refuses
while any unexpired legacy session remains, rather than guessing which sessions
to retain. Existing sessions expire within their original twelve-hour lifetime.
Never relabel a session from its hash or revoke all sessions as a migration shortcut.

Use one independently revocable service credential per consumer:

1. An authenticated human browser calls `POST /api/v2/browser/service-credentials`
   with `{username,current_password,label}` and its normal CSRF header. The secret
   `service_token` is returned once, with `Cache-Control: no-store`; Core stores
   only its hash. It expires after thirty days. Store it through the operator's
   protected secret-file process, never in chat, logs or a source checkout.
2. A loopback automation client with no Origin header exchanges
   `{service_token}` at `POST /api/v2/machine/service-session`. The returned cookie
   and CSRF projection have the existing browser-shaped API protocol, with a
   distinct service session kind. The client must still verify expected owner
   and exact server source identity. Sessions last at most twelve hours and never
   outlive the service credential.
3. Compatibility clients accept a protected 0600 credential JSON file containing
   only `{service_token}`. The legacy `{username,password}` format remains
   compatible during migration, but is not independent of the human password.
4. `GET /api/v2/browser/service-credentials` lists metadata only.
   `DELETE /api/v2/browser/service-credentials/{id}` atomically revokes that key
   and every session it issued. Service sessions cannot manage credentials or
   change the human password. A maximum of sixteen active credentials per owner
   and sixty-four active sessions per key bounds issuance without evicting other
   consumers during overlapping starts.

Password changes preserve service sessions and service credentials. Service-key
rotation and revocation remain explicit operations. On a 401 the compatibility
client stays refused for unchanged credentials; an operator's replacement of
the protected file permits a new authenticated login on the next attempt. It
does not replay the failed mutation or turn an uncertain outcome into success.

### Provision a consumer's private credential

From the pinned source checkout, run the helper as the account that will own the
consumer's file. Supply the reviewed origin, loopback address, owner UUID and full
deployed source commit. The output directory must already be private (0700) with
trusted parents; the output file must not exist.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m v2.compat.v1_runtime.provision_service_credential \
  --origin https://example.test --loopback-url http://127.0.0.1:19822 \
  --expected-owner OWNER_UUID --expected-source FULL_DEPLOYED_COMMIT \
  --credentials-path /private/operator/owner.json \
  --output /private/operator/adapter-service.json --label whatsapp-adapter
```

The helper checks the exact server build before sending credentials, issues one
key, verifies a service exchange using the consumer's actual client, and publishes
only `{service_token}` in a new 0600 file. It preserves the human credential file
and never prints secrets. Failed verification revokes a known issued key. An
unknown creation outcome requires checking the credential metadata before any
retry. The helper logs out its temporary cookies and reports the credential ID
and thirty-day lifetime; keep that metadata for explicit renewal/revocation.

Provisioning does not activate the file, restart a consumer or enable rotation.
Change each consumer's reference through its normal deployment process and
verify it independently. Renew service credentials before the thirty-day expiry.

Short-lived helpers can opt in to `ServiceSessionCache` from
`v2.compat.v1_runtime.service_session_cache`. Its caller-owned 0700 directory
contains a 0600 secret cookie cache and lock. Keep it in private runtime state,
outside source and sealed release directories. The helper holds the lock through
one operation, rechecks source/owner/session and persists login state before
yielding the client. Repeated invocations reuse the cookie rather than consuming
the login rate/session caps. Observed revocation remains refused across processes
until the protected key file changes. Corrupt or linked cache files fail closed.
No successful mutation is followed by a cache write, and no uncertain operation
is replayed. Long-running adapters continue to keep their sessions in memory.

The implementation does not by itself migrate live consumers or provide a
forgotten-password recovery CLI. Those remain release acceptance requirements.
