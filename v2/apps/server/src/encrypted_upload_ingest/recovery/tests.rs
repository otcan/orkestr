use super::*;
use std::{
    io::Write,
    os::unix::fs::{symlink, PermissionsExt},
};
fn name() -> String {
    format!(".{}.{}.tmp", Uuid::new_v4(), Uuid::new_v4())
}
struct Case {
    root: std::path::PathBuf,
    export: ExportDir,
    folder: std::path::PathBuf,
}
impl Case {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("export-recovery-{}", Uuid::new_v4()));
        let dir = root.join("exports");
        let folder = dir.join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&folder).unwrap();
        for p in [&root, &dir, &folder] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            root,
            export: ExportDir { dir, gid: None },
            folder,
        }
    }
}
impl Drop for Case {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn active_writer_is_never_reaped_and_abandoned_private_bytes_are_removed() {
    let c = Case::new();
    let folder = private_fs::directory(&c.folder, false).unwrap();
    let filename = name();
    let mut file = private_fs::create_locked_temporary(&folder, &filename).unwrap();
    file.write_all(b"incomplete private bytes").unwrap();
    let active = recover(&c.export).unwrap();
    assert_eq!(active.busy, 1);
    assert_eq!(active.removed, 0);
    assert!(c.folder.join(&filename).exists());
    drop(file);
    let abandoned = recover(&c.export).unwrap();
    assert_eq!(abandoned.removed, 1);
    assert!(!c.folder.join(filename).exists());
}

#[test]
fn killed_writer_releases_kernel_lock_and_recovery_removes_private_orphan() {
    use std::{
        io::Read,
        process::{Command, Stdio},
    };
    let c = Case::new();
    let filename = name();
    let path = c.folder.join(&filename);
    let mut child = Command::new("/usr/bin/python3")
        .args(["-I", "-S", "-B", "-c", "import os,sys,fcntl,time\nf=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nfcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nos.write(f,b'private incomplete plaintext');os.fsync(f)\nos.write(1,b'R');time.sleep(30)"])
        .arg(&path).env("PYTHONDONTWRITEBYTECODE", "1")
        .stdout(Stdio::piped()).spawn().unwrap();
    let mut ready = [0];
    child.stdout.take().unwrap().read_exact(&mut ready).unwrap();
    assert_eq!(ready, [b'R']);
    assert_eq!(recover(&c.export).unwrap().busy, 1);
    child.kill().unwrap(); // SIGKILL, without userspace cleanup.
    assert!(!child.wait().unwrap().success());
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(recover(&c.export).unwrap().removed, 1);
    assert!(!path.exists());
}

#[test]
fn aliases_hardlinks_publication_files_and_nonprivate_or_unknown_names_are_untouched() {
    let c = Case::new();
    let folder = private_fs::directory(&c.folder, false).unwrap();
    let external = c.root.join("outside");
    std::fs::write(&external, b"never touch").unwrap();
    let alias = c.folder.join(name());
    symlink(&external, &alias).unwrap();
    let hard = name();
    let mut file = private_fs::create(&folder, &hard, 0o600).unwrap();
    file.write_all(b"hardlinked").unwrap();
    drop(file);
    std::fs::hard_link(c.folder.join(&hard), c.root.join("hardlink")).unwrap();
    let readable = name();
    private_fs::create(&folder, &readable, 0o640).unwrap();
    let published = format!("{}.bin", Uuid::new_v4());
    private_fs::create(&folder, &published, 0o640).unwrap();
    let unknown = ".unrecognized.tmp";
    private_fs::create(&folder, unknown, 0o600).unwrap();
    let result = recover(&c.export).unwrap();
    assert_eq!(result.removed, 0);
    assert!(result.skipped >= 3);
    assert_eq!(std::fs::read(external).unwrap(), b"never touch");
    for p in [hard, readable, published, unknown.into()] {
        assert!(c.folder.join(p).exists());
    }
    assert!(alias.is_symlink());
}

#[test]
fn directory_alias_or_writable_scope_does_not_authorize_deletion() {
    let c = Case::new();
    let outside = c.root.join("outside");
    std::fs::create_dir(&outside).unwrap();
    let candidate = outside.join(name());
    std::fs::write(&candidate, b"private").unwrap();
    std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&outside, c.export.dir.join(Uuid::new_v4().to_string())).unwrap();
    let filename = name();
    std::fs::write(c.folder.join(&filename), b"private").unwrap();
    std::fs::set_permissions(
        c.folder.join(&filename),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    std::fs::set_permissions(&c.folder, std::fs::Permissions::from_mode(0o770)).unwrap();
    assert_eq!(recover(&c.export).unwrap().removed, 0);
    assert!(candidate.exists());
    assert!(c.folder.join(filename).exists());
}
