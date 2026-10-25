# Orkestr V2 Linux beta

Self-hosted conversations with Fast/Deep, Codex and Claude using your own CLI
logins, timers/digests, result review, Stop and explicit provider handoff.
The first public beta follows the existing version line: **2.0.0-beta.4**.
It has not been published. See the [release checklist](../docs/v2/public-beta-checklist.md)
for remaining acceptance gates; an image build does not prove a provider answer.

## Docker quickstart

Requires Linux x86_64, Docker Engine with Compose v2, public registry access,
and your own Codex and Claude logins. Allow at least 8 GiB RAM and 25 GiB free
disk for the source build; allow roughly 10–30 minutes depending on the machine
and registry speed. ARM, Windows, macOS and desktop packages are deferred.

Before publication, use the reviewed candidate branch below. After publication,
select the approved tag instead:

```sh
git clone --branch feat/v2-beta1-install https://github.com/otcan/orkestr.git
cd orkestr
export ORKESTR_SOURCE_COMMIT=$(git rev-parse HEAD)
docker compose -f v2/packaging/oss/compose.yaml up -d --build
docker compose -f v2/packaging/oss/compose.yaml ps
```

The image fetches the exact public commit anonymously; no host home, credentials
or application state is copied. Open **http://127.0.0.1:19822**. Only loopback is
published. On a remote Linux server, use an SSH port forward and the same URL.

### Create your Orkestr account

Choose **First-time setup**. Retrieve the local bootstrap token in your own
terminal, enter it in the form, then choose a username and a password of at least
12 characters. Keep the token private:

```sh
docker compose -f v2/packaging/oss/compose.yaml exec --user 10001:10001 orkestr cat /state/bootstrap.token
```

This is a local Orkestr account, separate from your provider accounts. Sign in
after creating it. Until provider setup completes, the UI and saved conversations
work and container logs report `provider_login_required`.

### Connect your own providers

Run each official CLI **inside the container** and complete its browser login
yourself. Do not paste provider tokens into an Orkestr conversation:

```sh
docker compose -f v2/packaging/oss/compose.yaml exec orkestr orkestr-beta login codex
docker compose -f v2/packaging/oss/compose.yaml exec orkestr orkestr-beta login claude
docker compose -f v2/packaging/oss/compose.yaml exec orkestr orkestr-beta configure
docker compose -f v2/packaging/oss/compose.yaml restart orkestr
```

Codex uses `codex login --device-auth` ([official OpenAI documentation](https://learn.chatgpt.com/docs/auth));
Claude uses `claude auth login` ([official Claude documentation](https://code.claude.com/docs/en/authentication)).
Your browser may run on your own computer. The CLI processes and their login
stores belong to container UID 10001. Codex uses `/credentials/codex`; Claude uses
`/credentials/claude`, in the **credentials named volume**, separate from Core
data. Logins persist across container replacement and are absent from images
and CI evidence.

`configure` verifies both CLI login states, asks privately for your **Orkestr**
username/password, then binds your owner and global conversation through the
authenticated API. It generates a closed manager/role/timer configuration using
fixed container paths. No API keys or host paths need to be pasted into JSON.

## Security model

The AI agent has full tool access **inside the container**, subject to Unix file
permissions. Model processes run as **non-root UID 10001** under the protected
root manager. The writable persistent surface is the service-owned portions of
the **state and credentials named volumes**; temporary files use container
tmpfs. The agent can read its provider logins. Never bind-mount sensitive host
paths, a host home, the Docker socket, devices or host PID namespaces into this
instance. It is for one trusted owner, not mutually isolated tenants.

Expose the service only on localhost, or behind an authenticated HTTPS reverse
proxy with an exactly matching configured origin. The supplied Compose file
supports localhost and SSH forwarding; its origin is fixed to
`http://127.0.0.1:19822`. Public reverse-proxy origin configuration needs separate
qualification. Do not publish its internal port directly to the internet.

The root manager drops model processes to UID 10001. Provider tools can use the
container's workspaces and CLI credentials: this is a single trusted owner's
instance. Compose mounts no host files, Docker socket or host namespaces and
requests no privileged container access.

This uses the existing full-access provider profile **inside the Docker
boundary**. It does not use nested Bubblewrap namespaces, which Docker's default
seccomp policy may refuse. CI records that probe and verifies the provider UID
has zero effective capabilities; no `SYS_ADMIN`, privileged mode, host PID
namespace or relaxed seccomp policy is requested. The protected manager retains
its process ownership and cleanup checks. The restricted nested-sandbox profile
is outside this Compose beta's supported scope.

### First conversation, review and Stop

Reload the page, open the global conversation or create a new one, and send a
simple question. Observe Fast and Deep separately. Confirm a real answer and
ask a follow-up to check continuity. In **Chat settings**, enable review before
accepting to review proposed results explicitly. Use **Stop** during a longer
turn and wait for the confirmed stopped state before starting more work.

To switch providers with context, let the current window close, then use
**Chat settings → Change provider with context**. Review the summary, confirm
the switch and send a new message. See [Provider handoff](docs/provider-handoff.md).

### First timer/digest

Open the conversation's **Timers**, add a calendar timer, choose an explicit
timezone and future run, and enter a short digest instruction. Preview the next
runs before saving/enabling. Observe one scheduled run and accepted result; pause
it afterward if it was only an acceptance check. Timers use the same durable Core
and provider windows as messages. No WhatsApp destination is configured here.

## Tarball bundle

Export the existing #265 Linux server/UI tarball, its manifest, paired receipt
and SHA256SUMS from the same source/build:

```sh
docker build --build-arg SOURCE_COMMIT="$ORKESTR_SOURCE_COMMIT" \
  --target bundle --output type=local,dest=./v2-dist \
  --file v2/packaging/oss/Dockerfile .
cd v2-dist
sha256sum --check SHA256SUMS
```

This creates local candidates and does not publish them. The #265 tarball contains
the server and web UI; it does **not** install the protected persistent manager
or CLI logins. Use Compose for provider-enabled setup. A standalone provider-enabled
tarball installer remains a release checklist gap; bundle creation is not native
provider acceptance.

## State, shutdown and limits

```sh
docker compose -f v2/packaging/oss/compose.yaml logs --tail 50 orkestr
docker compose -f v2/packaging/oss/compose.yaml down
```

`down` retains both named volumes. Back them up with the service stopped;
credentials need private handling. `down -v` erases the instance and its logins.
Automatic upgrades, live migration and restart reconciliation are separate
acceptance gates. If startup refuses, retain the state and inspect the failure;
do not clear a manager ledger to force startup.

The job tracker is an **optional recipe**. It needs an explicitly selected
read-only local source with Inbox and Sent bodies. Checks are bounded; unresolved
events can wait for earlier thread evidence, and `more_mail` is not proof of
full catch-up for large mailboxes. Recurring scans require a separate owner action.

Deferred: desktop/macOS/Windows/ARM, mobile apps, turnkey WhatsApp or mail account
provisioning, multi-user hosting, optional integrations and full parity with
private operator deployments.

## Development and evidence

Full Rust and browser suites run in `.github/workflows/v2-rust.yml` and
`v2-browser.yml`. `v2-image.yml` builds the image and #265 bundle without publishing,
then tests a fresh isolated account through **provider login required**. CI uses
no real provider login or inference. The owner separately accepts both providers,
follow-up, Fast/Deep, review/Stop, switching and one timer before release.

On shared hosts use the assigned Cargo wrapper for changed-crate checks only;
see [AGENTS.md](../AGENTS.md). Full workspace suites belong in CI. The source
image build is the isolated installation check.
