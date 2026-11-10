# Orkestr

Orkestr V2 is the primary application: a self-hosted Rust runtime for persistent
agent conversations, browser desktops, schedules and provider integrations.
It is a local-first workstation for running persistent coding and
operations agents, with persistent threads and WhatsApp routing.
Use your own Codex CLI login; Claude is optional. State stays on your machine.

The current published image is **2.0.0-beta.6**, a pre-release. The `main`
branch tracks source accepted by the production release train; it can include
changes newer than the published image.

## Start V2

With Docker Engine on Linux x86_64/arm64 or Docker Desktop on Apple Silicon:

```sh
docker run -d --name orkestr --cap-add SYS_PTRACE -p 127.0.0.1:19822:19823 \
  -v orkestr-state:/state -v orkestr-credentials:/credentials \
  ghcr.io/otcan/orkestr:v2.0.0-beta.6
```

Open **http://127.0.0.1:19822** and follow the [V2 quick start](v2/README.md)
for account setup and provider login. The named volumes preserve application
state and credentials across container replacement. Remote servers should use
an SSH port forward; keep the API bound to loopback.

For current source builds, use the [V2 Compose instructions](v2/README.md#build-from-source-with-docker-compose).
See the [release notes](docs/releases/v2.0.0-beta.6.md),
[acceptance checklist](docs/v2/public-beta-checklist.md) and
[contributing guide](CONTRIBUTING.md).

## Development and releases

```text
feature branch → integration → prod → main
```

Open feature PRs against `integration`. CI tests and builds the integrated
candidate once. The release train pins that exact commit on `prod`, deploys
it, and advances `main` to the same commit after production acceptance.
A failed deployment leaves `main` unchanged. Details and recovery behavior are
in [the release train runbook](docs/release-train.md).

V1 and its Node bridge remain in this repository for compatibility. Its
[documentation](README.v1.md) and `:latest` image are legacy; use the explicit
V2 image tag above for the primary application.

[OSS vs managed](docs/oss-managed-boundary.md) · [MIT license](LICENSE) · [Security policy](SECURITY.md)
