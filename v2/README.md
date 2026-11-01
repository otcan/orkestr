# Orkestr V2 Linux beta

Self-hosted conversations with Fast/Deep, Codex and Claude using your own CLI
logins, timers/digests, result review, Stop and explicit provider handoff.
The current public beta is **2.0.0-beta.6**, a GitHub pre-release
([release notes](../docs/releases/v2.0.0-beta.6.md)). See the [release checklist](../docs/v2/public-beta-checklist.md)
for its acceptance gates; an image build does not prove a provider answer.

## Quick start: one docker run

For the unreleased local-account test candidate, a
[macOS and Linux terminal installer](packaging/oss/INSTALL-TEST.md) handles
image selection, checksum verification, loading and startup.

Needs Docker Engine on Linux (x86_64 or arm64) or Docker Desktop on an Apple
Silicon Mac. Both architectures are built and smoke-tested natively in CI.
Docker Desktop on Intel Macs and Windows runs the amd64 image but is untested.
Allow about 2 GB of memory for the container. The prebuilt multi-arch image is
`ghcr.io/otcan/orkestr:v2.0.0-beta.6`. V2 images use only `v2.0.0-beta.*` tags;
`:latest` and `v0.*` belong to the V1 image.

```sh
docker run -d --name orkestr --cap-add SYS_PTRACE -p 127.0.0.1:19822:19823 \
  -v orkestr-state:/state -v orkestr-credentials:/credentials \
  ghcr.io/otcan/orkestr:v2.0.0-beta.6
```

Then:

1. Open **http://127.0.0.1:19822** (use `127.0.0.1`, not `localhost`) and choose
   **First-time setup**. The setup token is in the container log; keep it private:
   `docker logs orkestr 2>&1 | grep 'First-time setup token'`
2. Create your Orkestr username and password (at least 12 characters), then sign in.
3. Choose **Connect models**. **Sign in to Codex** shows the official OpenAI
   link and a one-time code; open the link, sign in with your ChatGPT account and
   enter the code. Claude is optional: **Sign in to Claude**, approve it, then paste the code
   Claude shows you back into the page.
4. Enter your Orkestr username and password again and choose **Activate models**.
   Orkestr activates the models in about a minute without a container restart, and the page
   reloads into your conversation.

Data and logins live in the two named volumes, so they survive
`docker restart orkestr`, `docker stop`/`docker start` and replacing the
container with a newer image (`docker rm -f orkestr`, then the same `docker run`).
`docker rm -f orkestr && docker volume rm orkestr-state orkestr-credentials`
deletes everything.

`--cap-add SYS_PTRACE` is the only extra permission. Orkestr's root manager uses it
inside the container's own PID namespace to verify the exact server binary
it started, which runs as UID 10001 with no capabilities. The runtime sets
no-new-privileges itself. Nothing else from the host is mounted, and the port is bound
to loopback only. On a remote server, use an SSH port forward to the same URL.

## Build from source with Docker Compose

Requires Docker Engine with Compose v2 on Linux x86_64 or arm64 (aarch64), or
Docker Desktop on an Apple Silicon Mac (see below), public registry access,
and your own ChatGPT/Codex login (a Claude login is optional). **No prebuilt image is published: the
install builds Orkestr from source on your machine, which takes roughly 10–30
minutes** depending on the machine and registry speed. Allow at least 8 GiB RAM
and 25 GiB free disk. Source builds are tested on Linux x86_64/arm64 and Apple Silicon.

```sh
git clone --branch v2.0.0-beta.6 https://github.com/otcan/orkestr.git
cd orkestr
printf 'ORKESTR_SOURCE_COMMIT=%s\n' "$(git rev-parse HEAD)" > v2/packaging/oss/.env
docker compose -f v2/packaging/oss/compose.yaml up -d --build
docker compose -f v2/packaging/oss/compose.yaml ps
```

The `.env` line records the exact commit to build (Git ignores the file). Run
the commands from the `orkestr` checkout; later `exec`, `logs`, `restart` and
`down` commands work from any terminal without exporting anything.

The image fetches the exact public commit anonymously; no host home, credentials
or application state is copied. Open **http://127.0.0.1:19822**. Only loopback is
published. On a remote Linux server, use an SSH port forward and the same URL.

### macOS (Apple Silicon) with Docker Desktop

Docker Desktop on an M-series Mac runs a Linux arm64 VM, and the image builds
natively for `linux/arm64` (Codex and Claude CLIs use their official
arm64 Linux releases, pinned by checksum per architecture). Do not add
`--platform linux/amd64`: emulating x86 would make the Rust build take hours.

1. Install Docker Desktop 4.x and start it. In **Settings → Resources**, give the
   VM at least **8 GB memory** (a 2-job Rust release build peaks around 4–6 GB;
   less memory fails with a killed `rustc`), 4+ CPUs, and a **disk limit with
   25 GB free**. Keep the default Apple Virtualization framework and VirtioFS.
2. Run the same three commands as above in Terminal, from the `orkestr` checkout:

   ```sh
   printf 'ORKESTR_SOURCE_COMMIT=%s\n' "$(git rev-parse HEAD)" > v2/packaging/oss/.env
   docker compose -f v2/packaging/oss/compose.yaml up -d --build
   docker compose -f v2/packaging/oss/compose.yaml ps
   ```

3. Expect the first build to take roughly **15–40 minutes** on an M1–M4 (about
   the same as an x86 laptop; the build uses 2 compiler jobs to bound memory).
   Later `up -d` runs reuse the built image.

Known caveats on arm64: the bounded provider sandbox and workspace command/job
sandbox (seccomp + bubblewrap profiles) are Linux x86_64 only and refuse to run
elsewhere; the Docker beta does not use them (it runs providers in the
container's full-access profile), so they do not affect this install. Port
19822 is published on the Mac's loopback only. The image is not interchangeable
across architectures: rebuild it on each machine.

### Create your Orkestr account

Choose **First-time setup**. Retrieve the local bootstrap token in your own
terminal (it is also printed in `docker compose -f v2/packaging/oss/compose.yaml logs orkestr`),
enter it in the form, then choose a username and a password of at least
12 characters. Keep the token private:

```sh
docker compose -f v2/packaging/oss/compose.yaml exec --user 10001:10001 orkestr cat /state/bootstrap.token
```

This is a local Orkestr account, separate from your provider accounts. Sign in
after creating it. Until provider setup completes, the UI and saved conversations
work and container logs report `provider_login_required`.

### Connect your own providers

Use **Connect models** in the browser, as in the quick start above. Alternatively, run each
official CLI **inside the container** and complete its browser login yourself.
Codex is required; skip the `login claude` line if you have no Claude account.
Do not paste provider tokens into an Orkestr conversation:

```sh
docker compose -f v2/packaging/oss/compose.yaml exec orkestr orkestr-beta login codex
docker compose -f v2/packaging/oss/compose.yaml exec orkestr orkestr-beta login claude
docker compose -f v2/packaging/oss/compose.yaml exec orkestr orkestr-beta configure
```

Orkestr activates the configuration by itself a few seconds after `configure`.

Codex uses `codex login --device-auth` ([official OpenAI documentation](https://learn.chatgpt.com/docs/auth));
Claude uses `claude auth login` ([official Claude documentation](https://code.claude.com/docs/en/authentication)).
Your browser may run on your own computer. The CLI processes and their login
stores belong to container UID 10001. Codex uses `/credentials/codex`; Claude uses
`/credentials/claude`, in the **credentials named volume**, separate from Core
data. Logins persist across container replacement and are absent from images
and CI evidence.

Codex must use a ChatGPT sign-in (`--device-auth`); an OpenAI API-key login is
refused when the first window opens. With Claude signed in, Fast replies use
Claude; without it, Fast uses Codex. Sign in to Claude **before** `configure` if
you want it: the choice is recorded once and a configured install refuses
reconfiguration.

`configure` verifies the CLI login states, asks privately for your **Orkestr**
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

Compose adds **SYS_PTRACE to the root manager** so its existing peer checks can
verify `/proc/<owned-service-pid>/exe` after dropping the server to UID 10001.
Default Docker capabilities deny that cross-UID observation. The AI process
has **empty effective, permitted, inheritable, ambient and bounding capability
sets**, verified in CI on the actual non-root Core process and an exec child.
The container root manager clears its bounding/inheritable/ambient sets before
running the fully verified protected entry in the same process; it retains only
its already-held root execution privileges. Descendant execs cannot inherit
SYS_PTRACE. CI also proves the executable check fails without the added cap.
This capability is
confined to the container's own PID namespace; Compose mounts no host files,
Docker socket or host namespaces and does not use privileged mode.

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
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
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
read-only local source with Inbox and Sent bodies (synchronized Thunderbird
folders on the computer running Orkestr); the Docker install cannot see host mail
folders. **Gmail and LinkedIn job tracking are not part of this beta.** Checks are bounded; unresolved
events can wait for earlier thread evidence, and `more_mail` is not proof of
full catch-up for large mailboxes. Recurring scans require a separate owner action.

Deferred: desktop/Windows/Intel Mac native packages, mobile apps,
Gmail/LinkedIn job tracking, turnkey WhatsApp or mail account provisioning, multi-user hosting, optional integrations and full parity with
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
