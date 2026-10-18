//! Exercises the actual server executable and SIGKILL recovery over HTTP.
#[test]
fn http_and_crash_recovery() {
    let result = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/intake_process.py"
        ))
        .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
        .status()
        .expect("Python 3 is required for the independent HTTP/process probe");
    assert!(result.success(), "HTTP/process acceptance probe failed");
}
