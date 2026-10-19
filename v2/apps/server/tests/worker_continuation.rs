//! Synthetic actual HTTP/native process coverage; never account-backed execution.
#[test]
fn worker_original_proofs_allow_only_fresh_stopped_continuation() {
    let home =
        std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"));
    let report = home.join(format!("worker-continuation-{}.json", uuid::Uuid::new_v4()));
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/worker_continuation_http.py"
        ))
        .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
        .arg("--report")
        .arg(&report)
        .output()
        .expect("launch synthetic stopped Worker continuation oracle");
    assert!(
        output.status.success(),
        "Worker continuation oracle failed: {}\n{}\n{}; report={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
        report.display()
    );
}
