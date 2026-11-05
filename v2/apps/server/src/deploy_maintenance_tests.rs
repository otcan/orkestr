use super::*;
use std::fs::{self, Permissions};
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;

// Root ancestry is part of the contract. Explicit root runner only: ordinary
// shared-host /tmp is deliberately not trusted even for synthetic fixtures.
#[test]
#[ignore = "requires explicit root disposable-custody fixture"]
fn protected_marker_survives_restart_and_unprivileged_cannot_clear_it() {
    assert_eq!(fs::metadata("/proc/self").unwrap().uid(), 0);
    let dir = PathBuf::from(format!(
        "/orkestr-maintenance-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, Permissions::from_mode(0o755)).unwrap();
    let path = dir.join("hold");
    let home = dir.join("ordinary-home");
    let drain = crate::deploy_drain::DeployDrain::default();
    drain.bind_maintenance(Some(&path), &home).unwrap();
    assert!(!drain.is_draining());
    fs::write(&path, b"synthetic operator transition").unwrap();
    assert!(
        drain.is_draining(),
        "checks marker synchronously, before polling"
    );
    drain.observe(Some(0), Some(1));
    assert!(drain.status().drained);
    let status = std::process::Command::new("/usr/bin/rm")
        .arg(&path)
        .uid(65534)
        .gid(65534)
        .output()
        .unwrap()
        .status;
    assert!(
        !status.success() && path.exists(),
        "executor cannot remove Root hold"
    );
    let restarted = crate::deploy_drain::DeployDrain::default();
    restarted.bind_maintenance(Some(&path), &home).unwrap();
    fs::create_dir(&home).unwrap();
    fs::write(home.join(crate::deploy_drain::REQUEST_FILE), b"stale").unwrap();
    restarted.bind(&home);
    assert!(!home.join(crate::deploy_drain::REQUEST_FILE).exists());
    assert!(
        restarted.is_draining(),
        "legacy stale cleanup cannot clear Root maintenance"
    );
    restarted.set(false);
    assert!(restarted.is_draining());
    fs::remove_file(&path).unwrap();
    assert!(
        !restarted.is_draining(),
        "only Root publication resumes admission"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires explicit root disposable-custody fixture"]
fn changed_directory_alias_and_writable_ancestry_fail_closed() {
    assert_eq!(fs::metadata("/proc/self").unwrap().uid(), 0);
    let dir = PathBuf::from(format!(
        "/orkestr-maintenance-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, Permissions::from_mode(0o755)).unwrap();
    let home = dir.join("home");
    let parent = dir.join("operator");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("hold");
    let marker = Marker::bind(&path, &home).unwrap();
    assert!(!marker.held());
    fs::rename(&parent, dir.join("old")).unwrap();
    fs::create_dir(&parent).unwrap();
    assert!(
        marker.held(),
        "replaced directory never proves absent marker"
    );
    fs::set_permissions(&parent, Permissions::from_mode(0o777)).unwrap();
    assert!(Marker::bind(&path, &home).is_err());
    fs::set_permissions(&parent, Permissions::from_mode(0o755)).unwrap();
    let alias = dir.join("alias");
    symlink(&parent, &alias).unwrap();
    assert!(Marker::bind(&alias.join("hold"), &home).is_err());
    assert!(Marker::bind(&home.join("hold"), &home).is_err());
    // A symlink or directory in the final marker position is a hold, never an
    // alias to be followed to an absent/uncontrolled destination.
    symlink(dir.join("absent"), &path).unwrap();
    assert!(Marker::bind(&path, &home).unwrap().held());
    fs::remove_dir_all(dir).unwrap();
}
