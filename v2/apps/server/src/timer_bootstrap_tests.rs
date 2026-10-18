use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
#[test]
fn private_scheduler_selectors_refuse_aliases_permissions_and_excess_bytes() {
    let root = std::env::temp_dir().join(format!("timer-bootstrap-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let file = root.join("synthetic-config");
    std::fs::write(&file, b"synthetic").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(private_file(&file, &root, 16).unwrap(), b"synthetic");
    assert!(private_file(&file, &root, 2).is_err());
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(private_file(&file, &root, 16).is_err());
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let alias = root.join("alias");
    symlink(&file, &alias).unwrap();
    assert!(private_file(&alias, &root, 16).is_err());
    std::fs::remove_file(&alias).unwrap();
    std::fs::hard_link(&file, &alias).unwrap();
    assert!(private_file(&file, &root, 16).is_err());
    assert!(private_file(Path::new("relative"), &root, 16).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn timer_bootstrap_config_has_no_clock_provider_issuer_or_unknown_fields() {
    assert!(serde_json::from_str::<Config>(
        r#"{"schema_version":1,"machine_token_file":"/tmp/fake"}"#
    )
    .is_ok());
    for extra in [
        "now_ms",
        "issuer",
        "provider",
        "takeover",
        "instruction",
        "owner",
    ] {
        let value =
            serde_json::json!({"schema_version":1,"machine_token_file":"/tmp/fake",extra:0});
        assert!(serde_json::from_value::<Config>(value).is_err());
    }
    assert!(serde_json::from_str::<Config>(
        r#"{"schema_version":1,"schema_version":1,"machine_token_file":"/tmp/fake"}"#
    )
    .is_err());
}
