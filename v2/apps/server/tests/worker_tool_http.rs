//! Ordinary Worker input and native result delivery through the fixed sandbox.
#[test]
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn owned_worker_tools_preserve_parent_scope_and_require_terminal_evidence() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/worker_tool_http.py"
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
            .matches("ordinary synthetic Worker HTTP case passed:")
            .count(),
        5
    );
}
