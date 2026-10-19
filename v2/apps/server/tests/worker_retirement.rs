//! Actual isolated HTTP/native process evidence, never account-backed execution.
#[test]
fn worker_original_reap_proofs_survive_parent_lifecycle() {
    let home =
        std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"));
    let report = home.join(format!("worker-retirement-{}.json", uuid::Uuid::new_v4()));
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/worker_retirement_http.py"
        ))
        .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
        .arg("--report")
        .arg(&report)
        .output()
        .expect("launch synthetic Worker retirement oracle");
    assert!(
        output.status.success(),
        "Worker original reap oracle failed: {}\n{}\n{}; report={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
        report.display()
    );
}
