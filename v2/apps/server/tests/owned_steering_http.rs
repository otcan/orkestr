//! Actual HTTP and native-writer composition with a synthetic provider.
#[test]
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn steering_is_scoped_durable_and_never_replayed_after_uncertainty() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/owned_steering_http.py"
        ))
        .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout)
            .matches("ordinary synthetic steering HTTP case passed:")
            .count(),
        9
    );
}
