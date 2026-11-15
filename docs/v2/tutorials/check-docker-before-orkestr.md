# Check Docker before installing Orkestr on Mac or Linux

A `docker run` command that waits without printing a container ID can be stuck
before Orkestr starts. Check whether the Docker client can reach its engine
before changing Orkestr settings or downloading another image. This guide helps
you distinguish a missing Docker command, an unavailable engine, a remote
context and an incompatible engine platform.

**Scope:** local terminal setup for the public Orkestr V2 beta, on Linux or an
Apple Silicon Mac using Docker Desktop. The diagnostic below changes no
containers, images, volumes, permissions or Docker settings. It creates a
private temporary output file and removes it on exit. Check factual commands
and release-specific instructions again when the linked release changes.

## Start with a bounded check

From a repository checkout containing this guide, run:

```bash
bash v2/packaging/oss/check-docker.sh
```

Bash is required; an additional Python installation is not. The helper is a
host-side documentation tool, not a command installed inside the beta.6 image.
It reports progress before contacting Docker and limits each of its two probes
to ten seconds. To choose a shorter limit:

```bash
bash v2/packaging/oss/check-docker.sh --timeout 3
```

A successful example looks like this. This is **illustrative output**, not a
claim that your installation has been tested:

```text
Checking local Docker; each probe has a 10-second limit...
Docker answered: linux/arm64. This checks Docker only; Orkestr installation and provider login are separate checks.
```

The helper first checks the selected local endpoint, then asks for the engine's
OS and architecture. It treats Docker's `x86_64`/`amd64` and
`aarch64`/`arm64` spellings as architecture aliases. A warning written to stderr
cannot be mistaken for the platform response. `DOCKER_CONTEXT` takes precedence
over `DOCKER_HOST`, following Docker's own selection rules. The helper rejects
remote contexts before the engine probe. It does not switch contexts for you.

Exit `0` means the selected local engine answered with a supported Linux
platform. Exit `2` means a prerequisite check failed. A successful result does
not prove that the registry is reachable, Orkestr is healthy or a model account
is connected.

## Use the failure to choose the next step

| Result | What it establishes | Next step |
| --- | --- | --- |
| Docker CLI missing | The terminal cannot find `docker` | Install Docker Desktop on Mac or Docker Engine on Linux using Docker's installation documentation; open a fresh terminal if needed. |
| Context check failed or timed out | Docker did not answer the local context inspection | Check the Docker application and selected context before retrying. |
| Local context required | The selected endpoint is remote | Inspect your contexts locally and deliberately select the intended local engine. Keep any existing remote workload intact. |
| Engine check failed or timed out | A local endpoint was selected, but the engine probe did not succeed | On Mac, check Docker Desktop's engine status. On Linux, check engine availability and your account's authorized Docker access. |
| Unexpected engine platform | The result did not match Linux amd64 or arm64 | Inspect the OS and architecture fields below; do not assume your host OS and container-engine OS are the same. |

### On a Mac: open Docker Desktop and wait for the engine

Open the Docker Desktop application, then rerun the bounded check. If startup
remains stuck, Docker documents **Troubleshoot → Restart Docker Desktop**.
Restarting Docker can interrupt other local containers, so account for other
workloads before doing it. Data cleanup and factory reset are different
operations and are not steps in this guide.

A Mac host can use a Linux container engine. The public beta.6 installation
instructions cover Apple Silicon; they do not qualify every Docker Desktop
version, Intel Mac or Windows host.

### On Linux: distinguish availability from access

A local engine can be stopped, unavailable at its configured socket, or
inaccessible to your account. Follow your distribution's Docker installation
and service guidance and Docker's post-installation documentation. This guide
does not change group membership or socket permissions. Docker documents that
membership in the `docker` group carries root-level privileges; do not make a
socket world-writable as a troubleshooting shortcut.

## Inspect only the fields you need

For a manual check, these commands display the current context and the engine
platform. They are Docker commands with Docker's own connection behavior;
unlike the helper, they do **not** impose a separate ten-second deadline.
If they wait indefinitely, interrupt them and use the bounded helper.

```bash
docker context show
docker info --format 'OS={{.OSType}} ARCH={{.Architecture}}'
```

An example platform response is `OS=linux ARCH=aarch64`. A Docker connection
error is a prerequisite failure; it is not evidence that Orkestr's account,
timer or model configuration failed. Full context listings can reveal endpoint
names and addresses. Inspect those locally rather than pasting an unreviewed
listing into a public issue.

## Once Docker answers, use the release-specific setup

Follow the [V2 quick start](../../../v2/README.md#quick-start-one-docker-run)
for the exact public image tag, local port mapping and named volumes. The
published beta.6 setup uses a bootstrap token followed by an Orkestr account
and provider sign-in. A newer source branch's password-only first-run flow is
a separate installation path; do not mix its instructions into beta.6 setup.

Keep bootstrap tokens and provider sign-in codes private. When asking for help,
report the guide step and the diagnostic's short result, the release tag and
your host/engine architecture. Do not attach credentials or a complete raw log.
The [install issue template](../../../.github/ISSUE_TEMPLATE/install_problem.md)
provides a structured report.

**Next step: [Open the public Orkestr V2 beta.6 release and installation notes](https://github.com/otcan/orkestr/releases/tag/v2.0.0-beta.6).**

## Sources and validation boundary

Sources reviewed on **2026-11-15**:

- [Docker system info](https://docs.docker.com/reference/cli/docker/system/info/):
  the formatted engine query and its `docker info` alias.
- [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/):
  endpoint selection and environment overrides.
- [Docker Desktop troubleshooting](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/):
  the application restart action.
- [Docker Engine post-installation](https://docs.docker.com/engine/install/linux-postinstall/):
  account access and privilege implications.
- [Public Orkestr beta.6 release](https://github.com/otcan/orkestr/releases/tag/v2.0.0-beta.6)
  and the [V2 quick start](../../../v2/README.md#quick-start-one-docker-run).

The helper is tested against synthetic Docker CLI processes for architecture
aliases, warnings, context overrides, remote-context refusal, an offline engine,
timeouts, process cleanup and invalid arguments. These tests never download or
start a container. They establish diagnostic behavior, not a fresh Orkestr
installation on every host. A real-engine readiness result and a completed
installation/provider conversation need separate evidence before this guide is
qualified for those hosts.
