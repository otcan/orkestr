//! Actual isolated server, auth boundary and Linux host observations over HTTP.
#[test]
fn resource_health_http() {
    let result = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/resource_health_process.py"
        ))
        .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
        .status()
        .expect("Python 3 is required for the resource HTTP probe");
    assert!(result.success(), "resource HTTP probe failed");
}
