//! Failed synthetic identity evidence cannot leave the fixture server running.
#[test]
fn failed_identity_assertion_preserves_failure_and_reaps_owned_server() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/owned_execution_cleanup.py"
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
}
