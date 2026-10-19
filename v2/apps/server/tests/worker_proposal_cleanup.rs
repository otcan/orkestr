//! Actual synthetic process cleanup before any owner acceptance of the parent.
#[test]
fn parent_proposal_cleans_workers_without_acceptance_or_new_dispatch() {
    let home =
        std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"));
    let report = home.join(format!("worker-proposal-cleanup-{}.json", uuid::Uuid::new_v4()));
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/worker_proposal_cleanup_http.py"
        ))
        .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
        .arg("--report")
        .arg(&report)
        .output()
        .expect("launch synthetic Worker proposal cleanup oracle");
    assert!(
        output.status.success(),
        "Worker proposal cleanup failed: {}\n{}\n{}; report={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
        report.display()
    );
}
