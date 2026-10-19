//! Real ordinary HTTP lifecycle, with a fixed synthetic native executable only.
#[test]
fn stop_and_clean_restart_admit_only_fresh_eligible_intent() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/owned_execution_recovery.py"
        ))
        .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
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
        3
    );
}
