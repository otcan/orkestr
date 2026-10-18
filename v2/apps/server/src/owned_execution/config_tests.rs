use super::config::Config;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    path: PathBuf,
    value: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("owned-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let home = root.join("data");
        let workspace = root.join("workspace");
        for path in [&home, &workspace] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let launcher = root.join("synthetic-launcher");
        fs::write(&launcher, "synthetic fixture, never executed").unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
        let token = root.join("machine-token");
        fs::write(&token, "ab".repeat(32)).unwrap();
        fs::set_permissions(&token, fs::Permissions::from_mode(0o600)).unwrap();
        let value = json!({
            "schema_version":1, "mode":"isolated-acceptance-v1",
            "conversation_id":uuid::Uuid::new_v4(),
            "machine_token_file":token, "launcher":launcher,
            "launcher_sha256":format!("{:x}",Sha256::digest(fs::read(&launcher).unwrap())),
            "workspace":workspace, "namespace":"synthetic:local", "supervisor_key":"synthetic-http"
        });
        Self {
            path: root.join("execution.json"),
            root,
            home,
            value,
        }
    }
    fn write(&self) {
        fs::write(&self.path, self.value.to_string()).unwrap();
        fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn load(&self) -> Result<Config, &'static str> {
        Config::load(&self.path, &self.home, "127.0.0.1:19822".parse().unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn private_explicit_config_is_validated_without_launching_anything() {
    let fixture = Fixture::new();
    fixture.write();
    let config = fixture.load().unwrap();
    assert_eq!(config.token(&fixture.home).unwrap(), "ab".repeat(32));
    assert!(Config::load(
        &fixture.path,
        &fixture.home,
        "0.0.0.0:19822".parse().unwrap()
    )
    .is_err());
}

#[test]
fn unknown_authority_fields_wrong_mode_hash_and_shared_workspace_are_refused() {
    for (field, value) in [
        ("provider_auth", json!("synthetic forbidden")),
        ("mode", json!("production")),
        ("launcher_sha256", json!("0".repeat(64))),
        ("namespace", json!("invalid/key")),
    ] {
        let mut fixture = Fixture::new();
        fixture.value[field] = value;
        fixture.write();
        assert!(fixture.load().is_err(), "accepted invalid {field}");
    }
    let mut fixture = Fixture::new();
    fixture.value["workspace"] = json!(fixture.home);
    fixture.write();
    assert!(fixture.load().is_err());
}

#[test]
fn private_config_token_and_launcher_aliases_are_refused() {
    for field in ["machine_token_file", "launcher"] {
        let mut fixture = Fixture::new();
        let alias = fixture.root.join("alias");
        std::os::unix::fs::symlink(fixture.value[field].as_str().unwrap(), &alias).unwrap();
        fixture.value[field] = json!(alias);
        fixture.write();
        assert!(fixture.load().is_err());
    }
    let fixture = Fixture::new();
    fixture.write();
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(fixture.load().is_err());
}

#[test]
fn modified_launcher_is_rechecked_and_errors_never_include_token_values() {
    let fixture = Fixture::new();
    fixture.write();
    let config = fixture.load().unwrap();
    fs::write(&config.launcher, "different synthetic launcher").unwrap();
    assert!(config.verify_launcher().is_err());
    fs::write(&config.machine_token_file, "synthetic-sensitive-value").unwrap();
    let error = config.token(&fixture.home).unwrap_err();
    assert!(!error.contains("synthetic-sensitive-value"));
}
