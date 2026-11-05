# Privileged loopback service transport

Unattended service clients require a Root-owned `peer_descriptor_path`. The
original Root manager publishes `service-peer.json` beside its control socket
from its retained Core `Popen` identity. The descriptor is Root0400 under
protected Root-owned ancestors and binds the owner, exact public source,
loopback endpoint, boot/network namespace, and original manager/Core
PID/start/UID/executable inode and SHA256. Clean shutdown removes only the
publisher's exact file. An existing live actor or changed file prevents adoption.

The client opens pidfds and connects without offering HTTP bytes. It correlates
the actual connected reverse TCP tuple/socket inode with an accepted FD held by
the exact Core process. Before each header/body write it rechecks that ownership,
original process incarnations, executable identity and manager relationship.
A port or self-reported health response cannot replace this proof. No automatic
reconnect carries a body to a replacement listener. Before-write failures are
refusals; failure after offering bytes has an unknown outcome and is not replayed.

This is a privileged Linux operator transport for the managed IPv4 loopback
endpoint. It requires Root access to cross-UID process/socket metadata. It does
not grant Root privileges to another service or elevate a frontend. Legacy human
password clients remain compatibility-only; service keys and cached service
sessions refuse missing peer configuration.

Pin all four runtime files: `__init__.py`, `rust_client.py`,
`service_session_cache.py`, and `service_peer.py`. `service_client.py` requires
the descriptor field in its closed config. Credential provisioning requires
`--peer-descriptor-path` and never writes over an existing output credential.
The Root manager's `publish_service_peer()` method is also the supported fixture
hook after retaining/attesting the original Core child; no process-label lookup
or caller-provided PID is an authority source.

Run the actual kernel fixture on a disposable privileged Linux test host:

```sh
sudo env PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B -m unittest discover \
  -s v2/compat/tests -p test_service_peer.py -v
sudo env PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B -m unittest discover \
  -s v2/compat/tests -p test_service_client.py -v
```

The fixture uses only synthetic HTTP data and two disposable numeric UIDs,
creates no accounts, sends no provider request, and makes no live configuration
change. It proves same-port foreign-UID spoofing receives zero HTTP/secret
bytes, and original-peer loss blocks both header and body writes.
