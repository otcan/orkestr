//! Ordinary server executable, selected Claude factory, real synthetic native I/O.
#[test]
fn ordinary_claude_http_initialization_observation_acceptance_and_refusal() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/owned_claude_http.py"
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
        4
    );
}
