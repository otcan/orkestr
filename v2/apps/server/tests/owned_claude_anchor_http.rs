//! Closed same-response input binding on the ordinary HTTP path, without account access.
#[test]
fn claude_omission_requires_current_input_and_exact_response() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/owned_claude_anchor_http.py"
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
            .matches("Claude anchor HTTP passed:")
            .count(),
        4
    );
}
