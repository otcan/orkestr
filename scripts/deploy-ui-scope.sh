#!/usr/bin/env bash
# Narrow an existing-install cutover without changing credentials, service units,
# runtime ownership, other connectors, account recovery, notifications or fan-out.
# The canonical deployer still owns locks, provenance, backups, drain and health.
deploy_ui_only() { [ "${ui_only_arg:-0}" = 1 ]; }

apply_ui_only_scope() {
  deploy_ui_only || return 0
  case "$command" in install|rollback) ;; *) echo '--ui-only requires install or rollback.' >&2; return 2;; esac
  if [ ! -L "$current_link" ] || [ "${ORKESTR_APP_DIR:-}" != "$current_link" ] ||
     [ "${ORKESTR_CURRENT_LINK:-}" != "$current_link" ] || [ "${ORKESTR_RELEASE_DEPLOY:-}" != 1 ]; then
    echo 'UI-only cutover requires an already configured versioned installation.' >&2
    return 2
  fi
  case "$codex_app_server_mode" in external|proxy|daemon) ;; *) echo 'UI-only cutover requires an existing external Codex runtime.' >&2; return 2;; esac
  if [ "$command" = install ]; then
    systemctl is-active --quiet "${service_name}.service" || return 2
  fi
  systemctl is-active --quiet "${codex_app_server_service_name}.service" || return 2
  local actual_directory
  actual_directory="$(systemctl show -p WorkingDirectory --value "${service_name}.service")" || return 2
  if [ "$actual_directory" != "$current_link" ]; then
    echo 'UI-only cutover requires the service to use the configured current release link.' >&2
    return 2
  fi
  # Scope restrictions win over environment defaults and conflicting CLI flags.
  sync_public_service=0
  sync_mailbox_mta=0
  sync_workers=0
  fanout_arg=0
  ORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND=''
  echo 'UI-only cutover: preserve existing ownership, security settings and unrelated services.'
}
