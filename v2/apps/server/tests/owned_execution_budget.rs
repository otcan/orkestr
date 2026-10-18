//! Ordinary HTTP policies use the same native Stop and original owned process.
fn check(args: &[&str], cases: usize) {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/owned_execution_budget.py"
        ))
        .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
        .args(args)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout)
            .matches("case passed:")
            .count(),
        cases
    );
}

#[test]
fn trusted_run_and_idle_budgets_stop_and_hold_existing_queue() {
    check(&[], 2);
}

#[test]
fn same_owned_process_survives_natural_lease_and_original_control_still_stops() {
    check(&["--long-only"], 1);
}

#[test]
fn revocation_reaps_the_renewed_child_without_fabricating_terminal_evidence() {
    check(&["--revoked-only"], 1);
}
