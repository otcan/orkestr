# Public apps

Public apps provide a stable, employee-facing application URL without exposing
an Orkestr thread, a shared-link bearer token, a tenant ID, or a backend URL.

```text
https://app.example.test/apps/operations
```

The `operations` slug is stable and non-secret. Orkestr resolves it on the
server to an opaque app ID, tenant binding, and private target reference. The
browser never supplies or receives the private target reference. The public
launcher lists only apps that the current OIDC session is authorized to use;
it never falls back to a thread or a pairing session.

## Enablement

This gateway is additive and disabled by default:

```env
ORKESTR_AUTH_PROVIDER=keycloak
ORKESTR_KEYCLOAK_ISSUER=https://keycloak.example.test/realms/orkestr
ORKESTR_KEYCLOAK_CLIENT_ID=orkestr-web
ORKESTR_KEYCLOAK_OIDC_ENABLED=1
ORKESTR_PUBLIC_APPS=1
ORKESTR_PUBLIC_APP_URL=https://app.example.test
```

Unauthenticated `/apps/:slug` requests redirect to `/auth/login`. A browser
pairing session is not an app-launcher fallback. Unknown, disabled, and
unauthorized app slugs use the same `404` response after sign-in.

## Access model

Apps are default-deny. The registry starts empty: signing in grants no app
access. An operator must first create each separate application boundary with
one of the explicit types `orkestr-ui`, `desktop`, or `oxrm`, bind it to opaque
`tenantRef` and `targetRef` values, and then grant a Keycloak subject, group,
or role the app role `viewer`, `editor`, or `admin`. A grant to one app type
does not imply access to another app, desktop, oXRM target, Orkestr thread, or
control-plane API. App roles apply only inside that app; they do not grant
Orkestr control-plane administrator access.

The user-facing APIs are:

```text
GET /api/me/apps
GET /api/apps/:slug
```

They return only authorized app cards and redact tenant, target, raw endpoint,
email, token, and grant-value data. Registry-management APIs are administrator
only and redact target and claim values as well.

Every stable route is re-resolved server-side before it reaches the launcher.
An app workload adapter must repeat that exact resolution for every protected
data or write request; it must not accept a target URL, tenant reference, or
resource identifier from the browser. Authorization failures intentionally use
the same response as an unavailable app.

## Private rollout artifacts

The public repository intentionally does not contain Keycloak realm exports,
Google credentials, magic-link authenticator binaries/configuration, DNS,
reverse-proxy vhosts, or oXRM target mappings. Apply those through the private
release process after the OSS gateway and tests are released.

Each private app adapter is responsible for mapping its opaque `targetRef` to
its isolated deployment and for enforcing the app role on every operation.
That includes a separate protected adapter for the Orkestr UI and for each
managed desktop surface; neither may turn a launcher grant into raw API,
thread, desktop-control, or endpoint access. An oXRM adapter must obtain its
binding from the server-side app resolution, not from an environment value
exposed to the browser. Do not add an arbitrary URL proxy or a target-map JSON
value to this public repository.
