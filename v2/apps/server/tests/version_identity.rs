//! Binary integration check. No token/config/listener is supplied: a regression
//! cannot start a service, and must still answer version before initialization.
use std::path::Path;
use std::process::Command;

fn query(root: &Path, home: Option<&Path>) -> serde_json::Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_orkestr-v2-server"));
    command
        .args(["--version", "--json"])
        .env_clear()
        .env("HOME", root.join("absent-user-home"))
        .current_dir(root);
    if let Some(home) = home {
        command.env("ORKESTR_V2_HOME", home);
    }
    let output = command.output().expect("owned version query");
    assert!(output.status.success(), "version must not need configuration");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("JSON version");
    assert_eq!(value["format"], "orkestr-v2-build-identity-v1");
    assert_eq!(value["component"], "server");
    assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
    assert!(value.get("error").is_none());
    assert!(!root.join("absent-user-home").exists());
    value
}

#[test]
fn binary_version_precedes_home_bootstrap_and_state() {
    let root = std::env::temp_dir().join(format!("v2-version-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir(&root).expect("fresh owned root");
    let result = std::panic::catch_unwind(|| {
        let unconfigured = query(&root, None);
        let absent = root.join("absent-v2-home");
        assert_eq!(query(&root, Some(&absent)), unconfigured);
        assert!(!absent.exists(), "version must not create V2 home");
        let existing = root.join("existing-v2-home");
        std::fs::create_dir(&existing).unwrap();
        std::fs::write(existing.join("sentinel"), b"synthetic untouched state").unwrap();
        assert_eq!(query(&root, Some(&existing)), unconfigured);
        assert_eq!(std::fs::read(existing.join("sentinel")).unwrap(), b"synthetic untouched state");
        assert_eq!(std::fs::read_dir(&existing).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    });
    std::fs::remove_dir_all(&root).expect("owned test cleanup");
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
