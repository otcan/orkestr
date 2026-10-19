"""Version 1 release requirements; these are policy, not execution evidence."""

SCHEMA_VERSION = 1
STAGES = ("development", "candidate", "full_release")

# A candidate adds real application/provider evidence to the offline baseline.
GATES = {
    "offline_vertical_slice": ("development", "fixture", {
        "durable_ingress", "distinct_roles", "follow_up_while_busy",
        "stop_fencing", "restart_recovery", "evidence_completion",
    }),
    "fixture_recovery": ("development", "fixture", {
        "duplicate_and_conflicting_requests", "crash_after_receipt",
        "expired_lease", "stale_completion", "uncertain_effect",
        "cancel_dispatch_race", "sse_reconnect",
    }),
    "ci": ("development", "ci", set()),
    "production_runtime": ("candidate", "production", {
        "atomic_admission", "distinct_roles", "session_identity",
        "leases_and_fences", "persisted_observations", "steering",
        "stop_fencing", "restart_recovery", "evidence_completion",
    }),
    "provider_codex": ("candidate", "real_provider", {
        "fast_conversation", "deep_reasoning", "supervised_worker",
        "follow_up_while_busy", "stop", "restart_recovery",
        "resume_fork_fresh", "auth_failure", "quota_failure",
    }),
    "provider_claude": ("candidate", "real_provider", {
        "fast_conversation", "deep_reasoning", "supervised_worker",
        "follow_up_while_busy", "stop", "restart_recovery",
        "resume_fork_fresh", "auth_failure", "quota_failure",
    }),
    "workflow_parity": ("candidate", "production", set()),
    "migration": ("candidate", "production", {
        "consistent_snapshot", "import_preview", "identity_mapping",
        "repeat_import", "counts_and_checksums", "quarantine",
        "dormant_side_effects", "excluded_credentials", "unchanged_source",
        "restored_backup", "before_writes_rollback",
        "post_writes_delta_reconciliation", "single_dispatcher",
    }),
    "security": ("candidate", "production", {
        "scope_authorization", "csrf_origin", "permission_revocation",
        "worker_containment", "secret_isolation_after_upgrade",
        "desktop_fences", "approval_replay", "nonoverlapping_homes",
        "memory_consent_forget_replay",
    }),
    "installation": ("candidate", "production", {
        "no_v1_dependency", "stop_only_v2", "unprivileged",
        "doctor_logs_version", "backup_export_import_preview",
    }),
    "web": ("candidate", "production", {
        "keyboard_accessibility", "mobile_browser", "attachments",
        "draft_stream_reconnect", "resource_health", "truthful_work_state",
        "large_history", "busy_composer",
    }),
    "performance": ("candidate", "production", set()),
    "soak": ("full_release", "production", {
        "daily_use", "durable_input", "no_duplicate_effects",
        "worker_liveness", "channel_ownership",
    }),
    "cutover": ("full_release", "production", {
        "fresh_backup", "active_work_reconciled", "final_import_verified",
        "single_dispatcher_handoff", "v1_data_retained", "rollback_preserved",
        "post_transfer_health", "post_transfer_workflows", "unknown_effects_reconciled",
    }),
    "release_artifacts": ("full_release", "ci", {
        "version_commit_alignment", "artifact_integrity", "provenance",
        "installation_docs", "migration_recovery_docs",
    }),
}

SOAK_SECONDS = 72 * 60 * 60
MAX_SOAK_SEGMENT_SECONDS = 60 * 60
MAX_FRESHNESS_SECONDS = 7 * 24 * 60 * 60
SHORT_FRESHNESS_SECONDS = 24 * 60 * 60
PERFORMANCE = {
    "input_acceptance": (250, 10),
    "stop_fencing": (250, 10),
    "thread_load": (2000, 1),
}
