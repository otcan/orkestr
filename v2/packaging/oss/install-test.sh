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
command_seconds=10
temporary_directory=
command_output=
active_command=
fail() { printf 'Orkestr: %s\n' "$*" >&2; exit 1; }
cleanup() {
    cleanup_status=$?
    if [[ -n "$active_command" ]]; then
        kill -TERM "$active_command" 2>/dev/null || true
        kill -KILL "$active_command" 2>/dev/null || true
        wait "$active_command" 2>/dev/null || true
    fi
    if [[ -n "$command_output" ]]; then rm -f -- "$command_output"; fi
    if [[ -n "$temporary_directory" ]]; then rm -rf -- "$temporary_directory"; fi
    return "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Do not depend on GNU timeout (absent from a standard Mac). Calls run in
# this shell so Ctrl+C and EXIT can reap the exact CLI process we started.
run_command() {
    local seconds=$1 command_deadline command_status
    shift
    "$@" > "$command_output" 2>&1 &
    active_command=$!
    command_deadline=$((SECONDS + seconds))
    while kill -0 "$active_command" 2>/dev/null; do
        if [[ "$SECONDS" -ge "$command_deadline" ]]; then
            kill -TERM "$active_command" 2>/dev/null || true
            kill -KILL "$active_command" 2>/dev/null || true
            wait "$active_command" 2>/dev/null || true
            active_command=
            return 124
        fi
        sleep 0.1
    done
    if wait "$active_command"; then command_status=0; else command_status=$?; fi
    active_command=
    return "$command_status"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --archive) [[ $# -ge 2 ]] || fail 'Missing archive filename.'; archive_path=$2; shift 2 ;;
        --no-open) open_browser=0; shift ;;
        --ready-seconds) [[ $# -ge 2 ]] || fail 'Missing timeout.'; ready_seconds=$2; shift 2 ;;
        --command-timeout) [[ $# -ge 2 ]] || fail 'Missing command timeout.'; command_seconds=$2; shift 2 ;;
        --help) printf 'Usage: bash install-test.sh [--archive FILE.zip|FILE.tar.gz] [--no-open] [--command-timeout SECONDS]\n'; exit 0 ;;
        *) fail "Unknown option: $1" ;;
    esac
done
[[ "$ready_seconds" =~ ^[0-9]+$ ]] || fail 'Timeout must be a nonnegative number of seconds.'
[[ "$command_seconds" =~ ^[1-9][0-9]*$ ]] || fail 'Command timeout must be a positive number of seconds.'
printf 'Orkestr local installer\nChecking Docker engine (timeout: %s seconds)...\n' "$command_seconds"
command -v docker >/dev/null || fail 'Install Docker Desktop (Mac) or Docker Engine (Linux), then run this installer again.'
command_output=$(mktemp)
if ! run_command "$command_seconds" docker info --format '{{.OSType}}|{{.Architecture}}'; then
    fail "Docker's engine is not responding. Open Docker Desktop and wait for Engine running; if it is stuck, use Troubleshoot > Restart Docker Desktop. On Linux, start your Docker service. Then run this installer again."
fi
engine=$(cat "$command_output")
case "$engine" in
    linux\|amd64|linux\|x86_64) candidate_arch=amd64 ;;
    linux\|arm64|linux\|aarch64) candidate_arch=arm64 ;;
    *) fail 'This candidate needs a Linux amd64 or arm64 Docker engine.' ;;
esac
endpoint=${DOCKER_HOST:-}
if [[ -z "$endpoint" ]]; then
    run_command "$command_seconds" docker context inspect --format '{{.Endpoints.docker.Host}}' || fail 'Docker did not answer the connection check. Restart Docker and rerun this installer.'
    endpoint=$(cat "$command_output")
fi
case "$endpoint" in
    unix://*|npipe://*|tcp://127.0.0.1:*|tcp://localhost:*) ;;
    *) fail 'Select a Docker engine on this computer; remote Docker contexts are not supported by the local installer.' ;;
esac

identity_template='{{.Config.Image}}|{{range (index .HostConfig.PortBindings "19823/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}|{{range .Config.Env}}{{if eq . "ORKESTR_OSS_LOCAL_SETUP=1"}}local{{end}}{{end}}'
printf 'Checking the existing installation...\n'
if run_command "$command_seconds" docker container inspect --format "$identity_template" "$candidate_container"; then
    existing=$(cat "$command_output")
else
    command_status=$?
    [[ "$command_status" != 124 ]] || fail 'Docker stopped responding while checking the existing installation. Restart Docker and rerun this installer.'
    existing=
fi
if [[ -n "$existing" && "$existing" != "$candidate_image|127.0.0.1:19822|local" ]]; then
    fail "Container $candidate_container belongs to a different installation. It was left unchanged."
fi

if [[ -z "$existing" ]]; then
    run_command "$command_seconds" docker ps --format '{{.Names}}|{{.Ports}}' || fail 'Docker did not answer the port check. Restart Docker and rerun this installer.'
    bindings=$(cat "$command_output")
    # macOS ships Bash 3.2, whose command-substitution parser rejects the
    # unbalanced case-pattern parentheses used by newer Bash versions.
    occupied=$(printf '%s\n' "$bindings" | awk -F '|' 'index($2, ":19822->") {print $1}')
    [[ -z "$occupied" ]] || fail "Port 19822 is already used by $occupied. Stop that container, then run this installer again."
    if run_command "$command_seconds" docker image inspect --format '{{.Os}}|{{.Architecture}}' "$candidate_image"; then
        image_platform=$(cat "$command_output")
    else
        command_status=$?
        [[ "$command_status" != 124 ]] || fail 'Docker stopped responding while checking the image. Restart Docker and rerun this installer.'
        image_platform=
    fi
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
            printf 'Checking access to the prebuilt test download...\n'
            if command -v gh >/dev/null && run_command "$command_seconds" gh auth status; then
                printf 'Downloading the prebuilt %s test image...\n' "$candidate_arch"
                run_command 600 gh run download "$candidate_run" --repo otcan/orkestr --name "$artifact_name" --dir "$temporary_directory" \
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
        run_command 180 docker load -i "$archive_path" || fail 'Docker did not finish loading the checked image within 180 seconds. Rerun the installer to recheck; existing data is preserved.'
        run_command "$command_seconds" docker image inspect --format '{{.Os}}|{{.Architecture}}' "$candidate_image" \
            || fail 'The archive did not contain the expected candidate image.'
        image_platform=$(cat "$command_output")
    fi
    [[ "$image_platform" = "linux|$candidate_arch" ]] || fail 'The loaded image does not match this Docker architecture.'
    printf 'Starting your local Orkestr test...\n'
    run_command 30 docker run -d --name "$candidate_container" --label org.orkestr.installer=docker-test-v1 \
        --cap-add SYS_PTRACE -e ORKESTR_OSS_LOCAL_SETUP=1 -p 127.0.0.1:19822:19823 \
        -v orkestr-419-state:/state -v orkestr-419-credentials:/credentials "$candidate_image" \
        || fail 'Docker could not start Orkestr. Port 19822 may be in use; no existing data was removed.'
else
    run_command "$command_seconds" docker container inspect --format '{{.State.Running}}' "$candidate_container" || fail 'Docker did not answer the existing-container check.'
    running=$(cat "$command_output")
    if [[ "$running" != true ]]; then run_command 30 docker start "$candidate_container" || fail 'Could not restart the existing test. Check whether Docker is running and port 19822 is free.'; fi
fi

printf 'Waiting for Orkestr to become healthy...\n'
deadline=$((SECONDS + ready_seconds))
while true; do
    run_command "$command_seconds" docker container inspect --format '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$candidate_container" || fail 'Docker stopped answering startup checks. Existing data is preserved; restart Docker and rerun the installer.'
    health=$(cat "$command_output")
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
