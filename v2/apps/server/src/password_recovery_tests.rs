use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

struct Home(std::path::PathBuf);
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("recovery-custody-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(path.join("core.sqlite3"), b"synthetic-metadata-only").unwrap();
        std::fs::set_permissions(
            path.join("core.sqlite3"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        Self(path)
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn recovery_requires_the_nonroot_authority_and_private_existing_core() {
    let home = Home::new();
    if rustix::process::geteuid().as_raw() == 0 {
        assert_eq!(private_core(&home.0), Err("recovery_authority_required"));
        return;
    }
    assert_eq!(private_core(&home.0), Ok(()));
    std::fs::set_permissions(&home.0, std::fs::Permissions::from_mode(0o750)).unwrap();
    assert_eq!(private_core(&home.0), Err("recovery_core_custody"));
    std::fs::set_permissions(&home.0, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(
        home.0.join("core.sqlite3"),
        std::fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    assert_eq!(private_core(&home.0), Err("recovery_core_custody"));
}

#[test]
fn database_and_sidecar_aliases_are_refused_before_store_open() {
    if rustix::process::geteuid().as_raw() == 0 {
        return;
    }
    let home = Home::new();
    let target = home.0.join("core.sqlite3");
    std::fs::hard_link(&target, home.0.join("extra-link")).unwrap();
    assert_eq!(private_core(&home.0), Err("recovery_core_custody"));
    std::fs::remove_file(home.0.join("extra-link")).unwrap();
    symlink(&target, home.0.join("core.sqlite3-wal")).unwrap();
    assert_eq!(private_core(&home.0), Err("recovery_core_custody"));
    assert_eq!(std::fs::read(&target).unwrap(), b"synthetic-metadata-only");
}

#[test]
fn operator_request_has_closed_fields_and_no_duplicate_scope() {
    let value = serde_json::json!({"owner_id":"synthetic","username":"synthetic",
        "password":"synthetic-password","revoke_legacy":false,"lock_device":1,"lock_inode":2});
    assert!(serde_json::from_value::<Request>(value.clone()).is_ok());
    let mut extra = value;
    extra["command"] = "must not execute".into();
    assert!(serde_json::from_value::<Request>(extra).is_err());
    assert!(serde_json::from_str::<Request>(r#"{"owner_id":"a","owner_id":"b","username":"synthetic","password":"synthetic-password","revoke_legacy":false,"lock_device":1,"lock_inode":2}"#).is_err());
}
