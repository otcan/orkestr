#!/usr/bin/env bash
# Install the prebuilt local-setup candidate. No source build or root required.
set -euo pipefail

candidate_commit=e7c3e890b9f10bd2c327d0ecdff4c41d008206ef
candidate_run=41204535602
candidate_image="orkestr-oss-test:$candidate_commit"
candidate_container=orkestr-candidate-419
installer_directory=$(cd -- "$(dirname -- "$0")" && pwd)
archive_path=
open_browser=1
ready_seconds=120
temporary_directory=
fail() { printf 'Orkestr: %s\n' "$*" >&2; exit 1; }
cleanup() { if [[ -n "$temporary_directory" ]]; then rm -rf -- "$temporary_directory"; fi; }
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
    case "$1" in
        --archive) [[ $# -ge 2 ]] || fail 'Missing archive filename.'; archive_path=$2; shift 2 ;;
        --no-open) open_browser=0; shift ;;
        --ready-seconds) [[ $# -ge 2 ]] || fail 'Missing timeout.'; ready_seconds=$2; shift 2 ;;
        --help) printf 'Usage: bash install-test.sh [--archive FILE.zip|FILE.tar.gz] [--no-open]\n'; exit 0 ;;
        *) fail "Unknown option: $1" ;;
    esac
done
[[ "$ready_seconds" =~ ^[0-9]+$ ]] || fail 'Timeout must be a nonnegative number of seconds.'
command -v docker >/dev/null || fail 'Install Docker Desktop (Mac) or Docker Engine (Linux), then run this installer again.'
engine=$(docker info --format '{{.OSType}}|{{.Architecture}}' 2>/dev/null) || fail 'Start Docker Desktop or your Docker service, then run this installer again.'
case "$engine" in
    linux\|amd64|linux\|x86_64) candidate_arch=amd64 ;;
    linux\|arm64|linux\|aarch64) candidate_arch=arm64 ;;
    *) fail 'This candidate needs a Linux amd64 or arm64 Docker engine.' ;;
esac
endpoint=${DOCKER_HOST:-}
if [[ -z "$endpoint" ]]; then
    endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null) || fail 'Could not inspect the Docker connection.'
fi
case "$endpoint" in
    unix://*|npipe://*|tcp://127.0.0.1:*|tcp://localhost:*) ;;
    *) fail 'Select a Docker engine on this computer; remote Docker contexts are not supported by the local installer.' ;;
esac

identity_template='{{.Config.Image}}|{{range (index .HostConfig.PortBindings "19823/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}|{{range .Config.Env}}{{if eq . "ORKESTR_OSS_LOCAL_SETUP=1"}}local{{end}}{{end}}'
existing=$(docker container inspect --format "$identity_template" "$candidate_container" 2>/dev/null || true)
if [[ -n "$existing" && "$existing" != "$candidate_image|127.0.0.1:19822|local" ]]; then
    fail "Container $candidate_container belongs to a different installation. It was left unchanged."
fi

if [[ -z "$existing" ]]; then
    bindings=$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null) || fail 'Could not check Docker port usage.'
    occupied=$(printf '%s\n' "$bindings" | while IFS='|' read -r other_name other_ports; do
        case "$other_ports" in *':19822->'*) printf '%s\n' "$other_name" ;; esac
    done)
    [[ -z "$occupied" ]] || fail "Port 19822 is already used by $occupied. Stop that container, then run this installer again."
    image_platform=$(docker image inspect --format '{{.Os}}|{{.Architecture}}' "$candidate_image" 2>/dev/null || true)
    if [[ -z "$image_platform" ]]; then
        archive_name="orkestr-oss-test-$candidate_arch.tar.gz"
        artifact_name="v2-test-image-$candidate_arch-$candidate_run"
        artifact_id=13043533020
        [[ "$candidate_arch" != arm64 ]] || artifact_id=13043852479
        artifact_url="https://github.com/otcan/orkestr/actions/runs/$candidate_run/artifacts/$artifact_id"
        if [[ -z "$archive_path" ]]; then
            for search_directory in "$PWD" "$installer_directory" "${HOME}/Downloads"; do
                for search_name in "$archive_name" "$artifact_name.zip"; do
                    if [[ -f "$search_directory/$search_name" ]]; then archive_path="$search_directory/$search_name"; break 2; fi
                done
            done
        fi
        temporary_directory=$(mktemp -d)
        if [[ -z "$archive_path" ]]; then
            if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
                printf 'Downloading the prebuilt %s test image...\n' "$candidate_arch"
                gh run download "$candidate_run" --repo otcan/orkestr --name "$artifact_name" --dir "$temporary_directory" \
                    || fail "Download failed. Download the ZIP at $artifact_url and run the installer again."
                archive_path="$temporary_directory/$archive_name"
            else
                printf 'Download this ZIP to Downloads, then run this installer again:\n%s\n' "$artifact_url"
                if [[ "$open_browser" = 1 ]]; then
                    if command -v open >/dev/null; then open "$artifact_url" || true
                    elif command -v xdg-open >/dev/null; then xdg-open "$artifact_url" >/dev/null 2>&1 || true; fi
                fi
                fail 'This unpublished test image needs a GitHub download. An existing signed-in gh CLI can download it automatically.'
            fi
        fi
        [[ -f "$archive_path" ]] || fail 'The selected archive does not exist.'
        case "$archive_path" in
            *.zip)
                command -v unzip >/dev/null || fail 'Extract the ZIP first, then select its .tar.gz file with --archive.'
                # Stream only the fixed members into files we create ourselves;
                # ZIP paths and symlink attributes never control extraction.
                unzip -p "$archive_path" "$archive_name" > "$temporary_directory/$archive_name" \
                    || fail 'The ZIP does not contain the image for this Docker architecture.'
                unzip -p "$archive_path" "$archive_name.sha256" > "$temporary_directory/$archive_name.sha256" \
                    || fail 'The ZIP does not contain the image checksum.'
                archive_path="$temporary_directory/$archive_name" ;;
            *.tar.gz) ;;
            *) fail 'Select the downloaded ZIP or .tar.gz image archive.' ;;
        esac
        [[ -f "$archive_path.sha256" ]] || fail 'Keep the .sha256 file beside the image archive.'
        read -r expected_hash checksum_name < "$archive_path.sha256"
        [[ "$expected_hash" =~ ^[a-fA-F0-9]{64}$ && "$checksum_name" = "$archive_name" ]] || fail 'Invalid image checksum receipt.'
        if command -v sha256sum >/dev/null; then actual_hash=$(sha256sum "$archive_path" | awk '{print $1}')
        elif command -v shasum >/dev/null; then actual_hash=$(shasum -a 256 "$archive_path" | awk '{print $1}')
        else fail 'A SHA256 tool is required (sha256sum or shasum).'; fi
        [[ "$actual_hash" = "$expected_hash" ]] || fail 'Image checksum mismatch. Download the archive again.'
        printf 'Loading the checked image into Docker...\n'
        docker load -i "$archive_path" >/dev/null || fail 'Docker could not load the checked image.'
        image_platform=$(docker image inspect --format '{{.Os}}|{{.Architecture}}' "$candidate_image" 2>/dev/null) \
            || fail 'The archive did not contain the expected candidate image.'
    fi
    [[ "$image_platform" = "linux|$candidate_arch" ]] || fail 'The loaded image does not match this Docker architecture.'
    printf 'Starting your local Orkestr test...\n'
    docker run -d --name "$candidate_container" --label org.orkestr.installer=docker-test-v1 \
        --cap-add SYS_PTRACE -e ORKESTR_OSS_LOCAL_SETUP=1 -p 127.0.0.1:19822:19823 \
        -v orkestr-419-state:/state -v orkestr-419-credentials:/credentials "$candidate_image" >/dev/null \
        || fail 'Docker could not start Orkestr. Port 19822 may be in use; no existing data was removed.'
else
    running=$(docker container inspect --format '{{.State.Running}}' "$candidate_container")
    if [[ "$running" != true ]]; then docker start "$candidate_container" >/dev/null || fail 'Could not restart the existing test. Check whether port 19822 is occupied.'; fi
fi

printf 'Waiting for Orkestr to become healthy...\n'
deadline=$((SECONDS + ready_seconds))
while true; do
    health=$(docker container inspect --format '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$candidate_container" 2>/dev/null || true)
    [[ "$health" != 'true|healthy' ]] || break
    [[ "$health" != false\|* && "$health" != 'true|unhealthy' ]] || fail 'The test container stopped or became unhealthy. Its data is preserved.'
    [[ "$SECONDS" -lt "$deadline" ]] || fail 'Startup is taking longer than expected. Data is preserved; run this installer again to recheck.'
    sleep 2
done
printf '\nOrkestr is ready: http://127.0.0.1:19822\nCreate your account, then choose Connect models.\nStop: docker stop %s\nStart: docker start %s\n' "$candidate_container" "$candidate_container"
if [[ "$open_browser" = 1 ]]; then
    if command -v open >/dev/null; then open http://127.0.0.1:19822 || true
    elif command -v xdg-open >/dev/null; then xdg-open http://127.0.0.1:19822 >/dev/null 2>&1 || true; fi
fi
