# Container listener opt-in

Native startup defaults to `127.0.0.1:19822`. `ORKESTR_V2_BIND` continues
to support native IPv4 and IPv6 loopback listeners.

A bridge-network container may explicitly set:

```text
ORKESTR_V2_BIND=0.0.0.0:19822
ORKESTR_V2_CONTAINER_BIND=1
ORKESTR_V2_ORIGIN=https://app.example.test
```

The origin must be the exact browser-facing HTTP or HTTPS origin, without
a path or trailing slash. It is never derived from the wildcard listener.
Only the exact opt-in value `1` is accepted. IPv6 wildcard and specific
nonloopback addresses are refused, including when opted in.

This configures the listener only. Existing Host, Origin, authentication,
and CSRF checks continue to apply. Container publishing and reverse-proxy
configuration must preserve the configured browser-facing authority.
