#!/usr/bin/env bash
# Sourced by the versioned deployer; no host configuration or side effects here.
configure_backup_policy() {
  backup_policy="${ORKESTR_DEPLOY_BACKUP_POLICY:-always}"
  backup_max_age="${ORKESTR_DEPLOY_BACKUP_MAX_AGE_SECONDS:-129600}"
  state_change="${state_change_arg:-${ORKESTR_DEPLOY_STATE_CHANGE:-0}}"
  case "$backup_policy" in always|scheduled) ;; *) echo "Invalid backup policy." >&2; return 2 ;; esac
  case "$state_change" in 0|1) ;; *) echo "State-change flag must be 0 or 1." >&2; return 2 ;; esac
  case "$backup_max_age" in ''|*[!0-9]*) echo "Backup max age must be positive seconds." >&2; return 2 ;; esac
  if [ "$backup_max_age" -le 0 ]; then echo "Backup max age must be positive seconds." >&2; return 2; fi
  local default_backup=1
  [ "$backup_policy" != scheduled ] || default_backup=0
  run_backup="${backup_state_arg:-${ORKESTR_DEPLOY_BACKUP_STATE:-$default_backup}}"
  case "$run_backup" in 0|1) ;; *) echo "Backup state must be 0 or 1." >&2; return 2 ;; esac
  backup_required=0
  if [ "$state_change" = 1 ] || [ "$command" = backup ]; then
    if [ "${backup_state_arg:-}" = 0 ]; then
      echo "Cannot disable a required migration/manual state backup." >&2
      return 2
    fi
    run_backup=1
    backup_required=1
  fi
}

require_recent_state_backup() {
  [ "$backup_policy" = scheduled ] || return 0
  local newest now age
  newest="$(find "$backup_dir" -maxdepth 1 -type f -size +0c \( -name '*-state.tar.gz' -o -name '*-state.tar.zst' -o -name '*-state.tar' \) -printf '%T@\n' 2>/dev/null | sort -nr | head -n 1)" || true
  newest="${newest%%.*}"
  now="$(date +%s)"
  age="$((now - ${newest:-0}))"
  if [ -z "$newest" ] || [ "$age" -lt 0 ] || [ "$age" -gt "$backup_max_age" ]; then
    echo "Scheduled state backup missing/stale; run orkestr-deploy backup before deploying." >&2
    return 1
  fi
  echo "Code-only release: reusing scheduled state backup (${age}s old); no full backup." >&2
}
