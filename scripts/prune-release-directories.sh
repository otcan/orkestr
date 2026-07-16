#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Prune inactive Orkestr release directories without removing the active release.

Usage:
  scripts/prune-release-directories.sh --releases-dir PATH --current-link PATH [--keep COUNT] [--preserve PATH]
USAGE
}

releases_dir=""
current_link=""
keep=3
preserve=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --releases-dir)
      releases_dir="${2:-}"
      shift 2
      ;;
    --current-link)
      current_link="${2:-}"
      shift 2
      ;;
    --keep)
      keep="${2:-}"
      shift 2
      ;;
    --preserve)
      preserve="${2:-}"
      shift 2
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

if [ -z "$releases_dir" ] || [ -z "$current_link" ]; then
  usage >&2
  exit 2
fi
case "$keep" in
  ''|*[!0-9]*) echo "--keep must be an integer from 1 to 3." >&2; exit 2 ;;
esac
if [ "$keep" -lt 1 ] || [ "$keep" -gt 3 ]; then
  echo "--keep must be an integer from 1 to 3." >&2
  exit 2
fi

mkdir -p "$releases_dir"
releases_root="$(readlink -f "$releases_dir")"
declare -A protected=()

direct_release_path() {
  local candidate resolved
  candidate="$1"
  [ -n "$candidate" ] || return 1
  resolved="$(readlink -m "$candidate")"
  [ "$(dirname "$resolved")" = "$releases_root" ] || return 1
  printf '%s\n' "$resolved"
}

protect_release() {
  local resolved
  resolved="$(direct_release_path "$1" 2>/dev/null || true)"
  [ -n "$resolved" ] || return 0
  [ -d "$resolved" ] || return 0
  protected["$resolved"]=1
}

if [ -L "$current_link" ]; then
  protect_release "$(readlink -f "$current_link")"
fi
protect_release "$preserve"

release_is_complete() {
  local release_dir deploy_script
  release_dir="$1"
  [ -f "$release_dir/release-manifest.json" ] || return 1
  deploy_script="$release_dir/scripts/deploy-git-release.sh"
  if [ -f "$deploy_script" ] && grep -q '\.orkestr-release-ready' "$deploy_script"; then
    [ -f "$release_dir/.orkestr-release-ready" ] || return 1
  fi
  return 0
}

removed=0
while IFS= read -r release_dir; do
  [ -n "$release_dir" ] || continue
  if [ "${protected[$release_dir]:-0}" = "1" ]; then
    continue
  fi
  if ! release_is_complete "$release_dir"; then
    rm -rf --one-file-system -- "$release_dir"
    removed=$((removed + 1))
  fi
done < <(find "$releases_root" -mindepth 1 -maxdepth 1 -type d -print)

retained=0
for release_dir in "${!protected[@]}"; do
  [ -d "$release_dir" ] || continue
  retained=$((retained + 1))
done

while IFS= read -r release_dir; do
  [ -n "$release_dir" ] || continue
  if [ "${protected[$release_dir]:-0}" = "1" ]; then
    continue
  fi
  if [ "$retained" -lt "$keep" ]; then
    retained=$((retained + 1))
    continue
  fi
  rm -rf --one-file-system -- "$release_dir"
  removed=$((removed + 1))
done < <(find "$releases_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@\t%p\n' | sort -rn | cut -f2-)

if [ "$removed" -gt 0 ]; then
  echo "Pruned $removed inactive or incomplete release directories, keeping max $keep in $releases_root." >&2
fi
