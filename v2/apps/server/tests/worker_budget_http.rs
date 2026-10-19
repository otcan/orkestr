//! Real elapsed Worker budgets, using isolated synthetic native and Python peers.
#[test]
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn owner_worker_budgets_preserve_deadlines_stop_and_tool_lineage() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/worker_budget_http.py"
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
            .matches("ordinary synthetic Worker budget HTTP case passed:")
            .count(),
        5
    );
}
