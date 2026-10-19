//! Mounting/authentication regression; only a synthetic native peer is launched.
#[test]
fn mounted_worker_discovery_requires_current_cookie_and_exact_scope() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/worker_discovery_http.py"
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
        1
    );
}
