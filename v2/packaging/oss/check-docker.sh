#!/usr/bin/env bash
# Read-only local Docker checks. Compatible with the macOS system Bash 3.2.
set -euo pipefail
probe_seconds=10
active_probe=
output=
fail() { printf 'Orkestr Docker check: %s\n' "$1" >&2; exit 2; }
cleanup() {
    if [[ -n "$active_probe" ]]; then
        kill -TERM "$active_probe" 2>/dev/null || true
        kill -KILL "$active_probe" 2>/dev/null || true
        wait "$active_probe" 2>/dev/null || true
    fi
    if [[ -n "$output" ]]; then rm -f -- "$output"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "${1:-}" = --help ]]; then
    printf 'Usage: bash check-docker.sh [--timeout SECONDS]\nRead-only local context and engine checks; no containers or volumes are changed.\n'
    exit 0
fi
if [[ $# -gt 0 ]]; then
    [[ $# = 2 && "$1" = --timeout ]] || fail 'Use --help for supported options.'
    probe_seconds=$2
fi
[[ "$probe_seconds" =~ ^[1-9][0-9]?$ ]] || fail 'Timeout must be an integer from 1 to 60 seconds.'
[[ "$probe_seconds" -le 60 ]] || fail 'Timeout must be an integer from 1 to 60 seconds.'
printf 'Checking local Docker; each probe has a %s-second limit...\n' "$probe_seconds"
command -v docker >/dev/null || fail 'Docker CLI missing. Install Docker Desktop on Mac or Docker Engine on Linux.'
output=$(mktemp)
probe() {
    local deadline status
    "$@" > "$output" 2>/dev/null &
    active_probe=$!
    deadline=$((SECONDS + probe_seconds))
    while kill -0 "$active_probe" 2>/dev/null; do
        if [[ "$SECONDS" -ge "$deadline" ]]; then
            kill -TERM "$active_probe" 2>/dev/null || true
            kill -KILL "$active_probe" 2>/dev/null || true
            wait "$active_probe" 2>/dev/null || true
            active_probe=
            return 124
        fi
        sleep 0.1
    done
    if wait "$active_probe"; then status=0; else status=$?; fi
    active_probe=
    return "$status"
}
endpoint=${DOCKER_HOST:-}
if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
    # Docker gives DOCKER_CONTEXT precedence over DOCKER_HOST.
    probe docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}' \
        || fail 'Docker context check failed or timed out. Check Docker Desktop or your Docker context.'
    endpoint=$(cat "$output")
elif [[ -z "$endpoint" ]]; then
    probe docker context inspect --format '{{.Endpoints.docker.Host}}' \
        || fail 'Docker context check failed or timed out. Check Docker Desktop or your Docker context.'
    endpoint=$(cat "$output")
fi
case "$endpoint" in
    unix://*|npipe://*|tcp://127.0.0.1:*|tcp://localhost:*) ;;
    *) fail 'This guide needs a local Docker context. No remote engine was contacted.' ;;
esac
probe docker info --format '{{.OSType}}|{{.Architecture}}' \
    || fail 'Docker engine check failed or timed out. On Mac, open Docker Desktop; on Linux, check engine status and your access.'
platform=$(cat "$output")
case "$platform" in
    linux\|amd64|linux\|x86_64) architecture=amd64 ;;
    linux\|arm64|linux\|aarch64) architecture=arm64 ;;
    *) fail 'Unexpected engine platform. Inspect docker info locally; Orkestr V2 needs Linux amd64 or arm64.' ;;
esac
printf 'Docker answered: linux/%s. This checks Docker only; Orkestr installation and provider login are separate checks.\n' "$architecture"
