//! Actual owned server, cookie auth, read-only execution status and reopen.
#[test]
fn authenticated_execution_projection() {
    let result = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/execution_process.py"
        ))
        .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
        .status()
        .expect("Python 3 is required for the HTTP execution probe");
    assert!(result.success(), "execution HTTP probe failed");
}
