# V2-only Docker Compose distribution (V2-034)

This source prepares an isolated distribution around existing Linux server and
web artifacts. It never uses the native archive installer inside the container:
that host tool correctly refuses overlay filesystem identity. No root manifest,
shared CI, V1 image, production deployment or restore format is changed.

## Source and runtime contract

Runtime owns `ORKESTR_V2_CONTAINER_BIND=1`, reviewed from source commit
`8bd994132e790d38fbc01ca2c8be3d353ad9661a`. This explicitly permits only an IPv4
wildcard container listener. Ordinary native loopback defaults stay unchanged.
The exact external `ORKESTR_V2_ORIGIN` must be set; the distribution currently
requires `http://127.0.0.1:<assigned-port>`. It never substitutes a wildcard origin
or host networking. This source inspection is separate from Runtime's author
three-test/clippy evidence and independent Verification review.

The historical native checkpoint server at source `c8358b7f` predates this bind
contract and **cannot** prove bridge publication works. A new admitted binary
containing the Runtime change, with its exact source commit and SHA-256, is a
required dependency before actual Docker acceptance.

## Prepare without a Docker daemon

```sh
python3 -B v2/packaging/docker/prepare.py \
  --binary "$admitted_linux_server" --binary-sha256 "$server_sha256" \
  --ui "$actual_generated_ui" --ui-inventory-sha256 "$ui_inventory_sha256" \
  --source-commit "$server_source_commit" --ui-source-commit "$ui_source_commit" \
  --output "$fresh_private_context" --base-image "$inspected_local_base_digest" \
  --origin "http://127.0.0.1:$assigned_port" --port "$assigned_port" \
  --bind-opt-in ORKESTR_V2_CONTAINER_BIND=1 --required-glibc "$required_glibc"
docker compose --file "$fresh_private_context/compose.json" config --quiet
```

The generator verifies assigned server and complete UI inventory hashes before
copying, checks the copies, refuses existing/overlapping destinations, and writes
only a fresh private context. Its Docker build context allowlist excludes all
other files. Full commits are supplied provenance, not reproduced builds. The
manifest records the copied server/UI/entrypoint hashes, ELF platform, declared
glibc requirement and exact origin/bind contract. Checksums are integrity checks,
not signatures or protection against a malicious trusted image/package author.

Only 64-bit little-endian x86-64 and ARM64 ELF inputs are recognized. macOS
Mach-O binaries are refused; Docker Desktop would need a separately built Linux
artifact, and both macOS/Docker Desktop and ARM64 remain untested. The inspected
historical x86-64 server requires `/lib64/ld-linux-x86-64.so.2`, libc, libm and
libgcc_s, with highest referenced GLIBC version 2.34. Reinspect the new binary;
this does not establish compatibility with every base. The supplied base must
already be local, pinned by immutable repository digest, provide Python 3.11+,
matching architecture, compatible glibc/loader/libgcc, a POSIX build shell and
mkdir/chown/chmod. Alpine/musl is unsuitable for that glibc artifact. No apt or
pip installation occurs. The declared glibc floor is not automatically verified
against the base; that is an actual-image gate.

## Isolation and lifecycle

Each context generates a unique `v2-install-<random>` project and image tag, an
explicit private named state volume, and an internal bridge. The only published
host address is 127.0.0.1. There is no daemon socket, host path, provider credential,
browser profile, legacy auth or service mount. Root is used only during image
assembly to establish ownership of the empty `/state` directory. The runtime
user is numeric UID/GID 10001, root filesystem read-only, all capabilities
dropped, no-new-privileges enabled, with bounded PIDs and private temporary
storage. No automatic restart policy is enabled.

A fresh volume is initialized from the image's empty 0700 `/state` directory.
The container generates its own private bootstrap token on first startup and
retains it for explicit restarts. It never imports another instance's auth.
The server receives only explicit V2 variables, isolated HOME and a fixed PATH;
inherited base-image/provider environment is discarded. The manifest and exact
origin are checked before state initialization or server execution. No provider
is configured or activated. Browser bootstrap handoff remains a separate gate.

## Exact owned build/run scope for coordinator admission

**Unexecuted pending independent source review, compatible admitted server and
inspected local base.** The Docker daemon is reachable via the explicitly
authorized `sudo -n docker` path; ordinary-user socket denial is not a blocker.
Docker reports Linux x86_64 server 29.1.3 and Compose 2.40.3. No local `python*`
base image was listed. Existing application images are not reused as bases,
because they may embed unrelated code/configuration. A narrow pinned Python
base import/pull must be admitted if no suitable clean local base is supplied;
no broad pulls, daemon changes or existing workload changes are authorized here.

Use the generated project's tag and exact copied context only. Refuse a
preexisting matching tag/project/volume, inspect the base locally, then:

```sh
sudo -n docker build --pull=false --network=none \
  --build-arg "BASE_IMAGE=$inspected_local_base_digest" \
  --tag "$owned_project:local" "$fresh_private_context"
python3 -B v2/packaging/docker/probe.py --sudo \
  --context "$fresh_private_context" \
  --reviewed-image-id "$exact_owned_image_id" \
  --reviewed-compose-sha256 "$reviewed_compose_sha256"
```

The build creates one owned image; its only RUN prepares directories. Source
review must cover the base digest and Dockerfile/context before this command.
A build failure must remove only an actually-created owned tag; do not prune
shared caches/images. The probe performs no builds or pulls, verifies the exact
reviewed Compose hash/image ID, refuses existing project resources/state volume
and occupied host port, then starts one owned service/container, one named
volume and one internal network. It checks health and UI index bytes. Its
`finally` block tears down that project's containers/network/volume and removes
only its owned image tag on success or startup/HTTP failure. A teardown failure
is surfaced and retains the image for inspection; it is never described as
successful cleanup. Preexisting-resource refusal never tears down occupants.
Stop uses SIGINT, matching server graceful shutdown. There is no backup/restore,
provider/execution or current-candidate browser claim in this initial probe.
The caller removes only its fresh private context after retaining sanitized
hash evidence, and must arrange owned-image cleanup if build fails before probe.

## Executed source checks and limitations

```sh
python3 -B -m unittest discover -s v2/packaging/docker/tests -v
```

Synthetic tests cover copied hash checks, exact origin, required bind opt-in,
security fields, private bootstrap persistence/environment exclusion, refusal of
tampered artifacts/existing contexts, and mocked daemon denial, occupied project
and failed-up cleanup. Actual Compose config parsing passed on a generated
synthetic context, without accessing a daemon. No image build/container run,
base compatibility, volume ownership propagation, bridge reachability or Docker
Desktop acceptance has been executed at this source checkpoint. Independent
source review and coordinator admission precede those owned image operations.

## Actual Linux checkpoint

The coordinator independently reviewed `d7d3868d` and admitted the narrow base
pull plus owned image probe. The actual build used Python 3.12 slim Bookworm,
immutable digest and exact image/Compose/artifact identities recorded in
`v2/packaging/docker/checkpoint.json`. Base inspection reported Linux amd64,
glibc 2.36; the admitted debug server requires glibc 2.34. Its full source is
`8bd994132e790d38fbc01ca2c8be3d353ad9661a`; the historical UI is from
`e9ea830e61614b792e77c8df01d968818530f567`. This remains mixed-source debug
packaging evidence, not release candidate or current browser acceptance.

The image built successfully without build networking. Compose startup and
in-container health passed, but host `127.0.0.1:19842` HTTP health returned
connection refused. **Docker acceptance failed.** Internal bridge publication
needs investigation; no host networking fallback or isolation weakening was
applied. Static HTTP verification could not execute. The probe's finalizer
removed its container, state volume, network and image tag. Independent resource
queries found zero remaining project resources; the private context was removed.
The explicitly pulled shared base remains cached. No provider, production mount,
daemon socket mount, restore apply or existing workload change occurred.

### Reproduced publication diagnosis

A second fresh owned run reproduced the failure. Sanitized inspect evidence is
in `v2/packaging/docker/network-diagnosis.json`. Docker accepted the requested
127.0.0.1:19842 binding in HostConfig, but effective NetworkSettings reported
`19822/tcp: null`. No host listener existed. The owned internal bridge had a
gateway and a connected host route. Inside-container HTTP returned 200; the host
request explicitly disabled proxies and was refused. Daemon security options
reported AppArmor/seccomp/cgroup namespaces, without rootless mode. These facts
locate the failure at publication on the sole internal bridge, before HTTP;
they do not establish any need to change host firewall rules. No daemon or
firewall changes were attempted. Owned cleanup again left zero resources.

Proposed minimum policy-preserving alternative, **not implemented or approved**:
retain the server's sole internal bridge and add an explicit host-side loopback
relay, supervised by the packaging launcher, that forwards only to the owned
container's inspected internal address/port. The host can route to that bridge;
actual direct reachability still needs a bounded test. The relay would bind only
the assigned loopback port, fail on occupants, disable proxies, and terminate
with the owned project. Container egress isolation remains unchanged. This adds
a host Python runtime/process requirement and replaces Docker port publication;
it therefore requires independent design/source review before implementation.
Simply changing `internal` to false would remove the egress boundary and is not
proposed. A fully Docker-native ingress alternative needs an independently
reviewed enforceable egress policy; disabling masquerading alone is insufficient.

### Explicit diagnostic egress policy (source proposal)

`prepare.py --network-policy diagnostic-egress-allowed` selects a normal private
Compose bridge while retaining loopback-only publication, fresh state, runtime
privilege restrictions and absence of host/socket/credential mounts. This policy
**permits outbound network routing**; it is not an outbound-denied sandbox. No
provider is configured or activated. The default remains `outbound-denied` and
continues to use the internal bridge. Both policies are recorded in the artifact
manifest. Unknown policies are rejected before creating a context.

This option is a concrete proposal for a root-admitted no-provider HTTP
checkpoint, not a product inference-routing decision. Independent source review
and explicit root topology admission precede an actual run with this option.
The earlier failed internal-bridge evidence remains valid. No host relay,
daemon/firewall changes or production workload modifications are required by
this proposal. Provider-enabled product routing and its acceptance stay separate.
