#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Deploy Orkestr from an exact git ref into versioned release directories.

Usage:
  scripts/deploy-git-release.sh install [--ref REF] [--channel NAME] [--allow-untagged|--require-tagged] [--no-smoke]
  scripts/deploy-git-release.sh rollback [--to RELEASE_ID]
  scripts/deploy-git-release.sh status [--json]
  scripts/deploy-git-release.sh --check-only

Environment:
  ORKESTR_ENV_FILE              Environment file. Defaults to /etc/orkestr/orkestr.env.
  ORKESTR_REPO_URL              Git repository URL. Defaults to https://github.com/otcan/orkestr.git.
  ORKESTR_DEPLOY_REF            Branch, tag, or commit to deploy. Defaults to ORKESTR_UPDATE_REF or main.
  ORKESTR_DEPLOY_CHANNEL        Deployment channel label. Defaults to production.
  ORKESTR_DEPLOY_TAGS_ONLY      Require an exact git tag. Defaults to 1 for production, 0 otherwise.
  ORKESTR_DEPLOY_ROOT           Root directory. Defaults to /opt/orkestr.
  ORKESTR_RELEASES_DIR          Release directory. Defaults to $ORKESTR_DEPLOY_ROOT/releases.
  ORKESTR_CURRENT_LINK          Active symlink. Defaults to $ORKESTR_DEPLOY_ROOT/current.
  ORKESTR_REPO_CACHE            Git cache. Defaults to $ORKESTR_DEPLOY_ROOT/repo-cache.
  ORKESTR_DEPLOY_HISTORY        JSON deployment history. Defaults to $ORKESTR_DEPLOY_ROOT/deployments.json.
  ORKESTR_DEPLOY_BACKUP_DIR     State backup directory. Defaults to $ORKESTR_DEPLOY_ROOT/backups.
  ORKESTR_DEPLOY_LOCK_FILE      Lock file. Defaults to /var/lock/orkestr-deploy.lock.
  ORKESTR_DEPLOY_RUN_SMOKE      Run npm smoke before activation. Defaults to 1.
  ORKESTR_DEPLOY_HEALTH_URL     Health URL. Defaults to http://$ORKESTR_HOST:$ORKESTR_PORT/api/health.
  ORKESTR_SERVICE_NAME          systemd service name. Defaults to orkestr.
  ORKESTR_BUILD_WEB_FROM_SOURCE Set to 1 to install dev dependencies and rebuild the Angular web app.

The app code is versioned. ORKESTR_HOME and /etc/orkestr/orkestr.env stay
outside release directories and are backed up before activation.
USAGE
}

command="install"
ref_arg=""
channel_arg=""
to_release=""
json_output=0
check_only=0
run_smoke_arg=""
tags_only_arg=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|rollback|status)
      command="$1"
      shift
      ;;
    --ref)
      ref_arg="${2:-}"
      shift 2
      ;;
    --channel)
      channel_arg="${2:-}"
      shift 2
      ;;
    --to)
      to_release="${2:-}"
      shift 2
      ;;
    --json)
      json_output=1
      shift
      ;;
    --no-smoke)
      run_smoke_arg=0
      shift
      ;;
    --smoke)
      run_smoke_arg=1
      shift
      ;;
    --allow-untagged|--allow-untagged-releases)
      tags_only_arg=0
      shift
      ;;
    --require-tagged|--require-tagged-releases)
      tags_only_arg=1
      shift
      ;;
    --check-only)
      check_only=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$check_only" -eq 1 ]; then
  exit 0
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

load_env() {
  local env_file
  env_file="${ORKESTR_ENV_FILE:-/etc/orkestr/orkestr.env}"
  if [ -r "$env_file" ]; then
    bash -n "$env_file"
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] || ""))' "$1"
}

sanitize_id() {
  printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._+-' '-'
}

health_check() {
  local url attempts
  url="$1"
  attempts="${2:-40}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Health check failed: $url" >&2
  return 1
}

write_history_event() {
  local status release_id ref commit previous_release release_dir backup_path error
  status="$1"
  release_id="$2"
  ref="$3"
  commit="$4"
  previous_release="$5"
  release_dir="$6"
  backup_path="$7"
  error="${8:-}"
  mkdir -p "$(dirname "$deploy_history")"
  node - "$deploy_history" \
    "$status" "$release_id" "$ref" "$commit" "$previous_release" "$release_dir" "$backup_path" "$error" "$deploy_channel" "$service_name" <<'NODE'
const fs = require("node:fs");
const [file, status, releaseId, ref, commit, previousRelease, releaseDir, backupPath, error, channel, serviceName] = process.argv.slice(2);
let history = [];
try {
  history = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(history)) history = [];
} catch {}
history.push({
  status,
  releaseId,
  ref,
  commit,
  previousRelease: previousRelease || null,
  releaseDir,
  backupPath: backupPath || null,
  error: error || null,
  channel,
  serviceName,
  deployedAt: new Date().toISOString(),
});
fs.writeFileSync(file, `${JSON.stringify(history.slice(-200), null, 2)}\n`);
NODE
}

current_release_id() {
  if [ -L "$current_link" ]; then
    basename "$(readlink -f "$current_link")"
  else
    echo ""
  fi
}

resolve_target_ref() {
  local ref
  ref="$1"
  if git -C "$repo_cache" rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
    git -C "$repo_cache" rev-parse "origin/$ref^{commit}"
    return 0
  fi
  if git -C "$repo_cache" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    git -C "$repo_cache" rev-parse "$ref^{commit}"
    return 0
  fi
  return 1
}

prepare_repo_cache() {
  mkdir -p "$(dirname "$repo_cache")"
  if [ -d "$repo_cache/.git" ]; then
    git -C "$repo_cache" remote set-url origin "$repo_url"
    git -C "$repo_cache" fetch --prune --tags origin
  else
    git clone --no-checkout "$repo_url" "$repo_cache"
    git -C "$repo_cache" fetch --prune --tags origin
  fi
}

backup_state() {
  local stamp target backup_name data_dir
  data_dir="${ORKESTR_HOME:-}"
  if [ -z "$data_dir" ] || [ ! -d "$data_dir" ]; then
    echo ""
    return 0
  fi
  mkdir -p "$backup_dir"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$(sanitize_id "$release_id")"
  backup_name="$backup_dir/${stamp}-${target}-state.tar.gz"
  tar -C "$(dirname "$data_dir")" -czf "$backup_name" "$(basename "$data_dir")"
  echo "$backup_name"
}

activate_release() {
  local release_dir next_link
  release_dir="$1"
  if [ -e "$current_link" ] && [ ! -L "$current_link" ]; then
    echo "Refusing to replace non-symlink current path: $current_link" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$current_link")"
  next_link="${current_link}.next"
  ln -sfn "$release_dir" "$next_link"
  mv -Tf "$next_link" "$current_link"
}

restart_and_verify() {
  systemctl restart "${service_name}.service"
  systemctl is-active --quiet "${service_name}.service"
  health_check "$health_url" 40
}

status_command() {
  local active
  active="$(current_release_id)"
  if [ "$json_output" -eq 1 ]; then
    printf '{"currentRelease":%s,"currentLink":%s,"history":%s}\n' \
      "$(json_string "$active")" \
      "$(json_string "$current_link")" \
      "$(json_string "$deploy_history")"
    return 0
  fi
  echo "Current release: ${active:-none}"
  echo "Current link: $current_link"
  echo "History: $deploy_history"
}

install_command() {
  local target_ref target_tag target_describe short_sha tag_required release_dir previous_release backup_path deployed_at
  prepare_repo_cache
  target_ref="$(resolve_target_ref "$deploy_ref")"
  target_tag="$(git -C "$repo_cache" describe --tags --exact-match "$target_ref" 2>/dev/null || true)"
  target_describe="$(git -C "$repo_cache" describe --tags --always --long "$target_ref" 2>/dev/null || echo "$target_ref")"
  tag_required="${tags_only_arg:-${ORKESTR_DEPLOY_TAGS_ONLY:-}}"
  if [ -z "$tag_required" ]; then
    if [ "$deploy_channel" = "production" ]; then tag_required=1; else tag_required=0; fi
  fi
  if [ "$tag_required" = "1" ] && [ -z "$target_tag" ]; then
    echo "Refusing production deploy without an exact git tag for $deploy_ref ($target_ref)." >&2
    exit 1
  fi
  short_sha="$(printf '%s' "$target_ref" | cut -c1-12)"
  release_id="$(sanitize_id "${target_tag:-$deploy_channel-$short_sha}")"
  release_dir="$releases_dir/$release_id"
  previous_release="$(current_release_id)"
  if [ "$previous_release" = "$release_id" ] && [ -d "$release_dir" ]; then
    echo "Orkestr already at $release_id ($target_ref)."
    return 0
  fi

  if [ ! -d "$release_dir/.git" ]; then
    mkdir -p "$releases_dir"
    git -C "$repo_cache" worktree add --detach "$release_dir" "$target_ref"
    (cd "$release_dir" && bash scripts/install-runtime-deps.sh)
    npm --prefix "$release_dir" run build:runtime
    deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    node "$release_dir/scripts/release-manifest.mjs" \
      --cwd "$release_dir" \
      --output "$release_dir/release-manifest.json" \
      --repo "$repo_url" \
      --ref "$deploy_ref" \
      --commit "$target_ref" \
      --tag "$target_tag" \
      --describe "$target_describe" \
      --channel "$deploy_channel" \
      --release-id "$release_id" \
      --service "$service_name" \
      --deployed-at "$deployed_at"
    if [ "$run_smoke" = "1" ]; then
      npm --prefix "$release_dir" run smoke
    fi
    npm --prefix "$release_dir" prune --omit=dev
  fi

  backup_path="$(backup_state)"
  activate_release "$release_dir"
  if restart_and_verify; then
    write_history_event "success" "$release_id" "$deploy_ref" "$target_ref" "$previous_release" "$release_dir" "$backup_path"
    echo "Orkestr deployed $release_id ($target_ref)."
  else
    write_history_event "failed" "$release_id" "$deploy_ref" "$target_ref" "$previous_release" "$release_dir" "$backup_path" "health_check_failed"
    exit 1
  fi
}

rollback_command() {
  local target release_dir previous_release backup_path commit
  if [ -n "$to_release" ]; then
    target="$to_release"
  else
    target="$(node - "$deploy_history" "$(current_release_id)" <<'NODE'
const fs = require("node:fs");
const [file, current] = process.argv.slice(2);
let history = [];
try { history = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const previous = [...history].reverse().find((entry) => entry.status === "success" && entry.releaseId && entry.releaseId !== current);
if (previous) process.stdout.write(previous.releaseId);
NODE
)"
  fi
  if [ -z "$target" ]; then
    echo "No previous release found for rollback." >&2
    exit 1
  fi
  release_dir="$releases_dir/$target"
  if [ ! -d "$release_dir" ]; then
    echo "Rollback target does not exist: $release_dir" >&2
    exit 1
  fi
  previous_release="$(current_release_id)"
  commit="$(git -C "$release_dir" rev-parse HEAD 2>/dev/null || true)"
  backup_path="$(backup_state)"
  activate_release "$release_dir"
  if restart_and_verify; then
    write_history_event "rollback" "$target" "$target" "$commit" "$previous_release" "$release_dir" "$backup_path"
    echo "Orkestr rolled back to $target."
  else
    write_history_event "rollback_failed" "$target" "$target" "$commit" "$previous_release" "$release_dir" "$backup_path" "health_check_failed"
    exit 1
  fi
}

load_env

deploy_root="${ORKESTR_DEPLOY_ROOT:-/opt/orkestr}"
releases_dir="${ORKESTR_RELEASES_DIR:-$deploy_root/releases}"
current_link="${ORKESTR_CURRENT_LINK:-$deploy_root/current}"
repo_cache="${ORKESTR_REPO_CACHE:-$deploy_root/repo-cache}"
deploy_history="${ORKESTR_DEPLOY_HISTORY:-$deploy_root/deployments.json}"
backup_dir="${ORKESTR_DEPLOY_BACKUP_DIR:-$deploy_root/backups}"
repo_url="${ORKESTR_REPO_URL:-https://github.com/otcan/orkestr.git}"
deploy_ref="${ref_arg:-${ORKESTR_DEPLOY_REF:-${ORKESTR_UPDATE_REF:-main}}}"
deploy_channel="${channel_arg:-${ORKESTR_DEPLOY_CHANNEL:-production}}"
service_name="${ORKESTR_SERVICE_NAME:-orkestr}"
host="${ORKESTR_HOST:-127.0.0.1}"
port="${ORKESTR_PORT:-19812}"
health_url="${ORKESTR_DEPLOY_HEALTH_URL:-http://$host:$port/api/health}"
run_smoke="${run_smoke_arg:-${ORKESTR_DEPLOY_RUN_SMOKE:-1}}"
lock_file="${ORKESTR_DEPLOY_LOCK_FILE:-/var/lock/orkestr-deploy.lock}"
release_id=""

need git
need npm
need node
need curl
need tar
need systemctl
need flock

if [ "$command" != "status" ]; then
  mkdir -p "$(dirname "$lock_file")"
  exec 9>"$lock_file"
  if ! flock -n 9; then
    echo "Another Orkestr deploy is already running."
    exit 0
  fi
fi

case "$command" in
  install) install_command ;;
  rollback) rollback_command ;;
  status) status_command ;;
  *)
    echo "Unknown command: $command" >&2
    usage >&2
    exit 2
    ;;
esac
