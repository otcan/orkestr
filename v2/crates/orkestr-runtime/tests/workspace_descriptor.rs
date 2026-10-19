#[path = "../src/containment/workspace_launch.rs"]
mod workspace_launch;

use std::fs::{self, File};
use std::os::fd::AsFd;
use std::os::unix::fs::MetadataExt;
use std::process::Command;
use workspace_launch::{Identity, WorkspaceDescriptor};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("workspace-fd-{}-{id}", std::process::id()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn identity(file: &File) -> Identity {
    let meta = file.metadata().unwrap();
    Identity {
        device: meta.dev(),
        inode: meta.ino(),
        owner: meta.uid(),
    }
}

#[test]
fn renamed_directory_not_replacement_is_actual_cwd_and_fd5() {
    let fixture = Fixture::new();
    let workspace = fixture.0.join("project");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("sentinel"), b"original").unwrap();
    let source = File::open(&workspace).unwrap();
    let descriptor = WorkspaceDescriptor::capture(source.as_fd(), identity(&source)).unwrap();
    fs::rename(&workspace, fixture.0.join("retained")).unwrap();
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("sentinel"), b"replacement").unwrap();
    drop(source);
    let mut command = Command::new("/usr/bin/python3");
    command.args(["-I", "-c", "import os; a=os.stat('.'); b=os.fstat(5); assert (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino); f=os.open('sentinel',os.O_RDONLY,dir_fd=5); assert os.read(f,32)==b'original'; os.close(f); print('pinned')"]);
    descriptor.configure(&mut command).unwrap();
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"pinned\n");
}

#[test]
fn foreign_identity_and_regular_file_refuse_before_spawn() {
    let fixture = Fixture::new();
    let directory = File::open(&fixture.0).unwrap();
    let expected = identity(&directory);
    let mut foreign = expected;
    foreign.inode = foreign.inode.wrapping_add(1);
    assert!(WorkspaceDescriptor::capture(directory.as_fd(), foreign).is_err());
    foreign = expected;
    foreign.device = foreign.device.wrapping_add(1);
    assert!(WorkspaceDescriptor::capture(directory.as_fd(), foreign).is_err());
    foreign = expected;
    foreign.owner = foreign.owner.wrapping_add(1);
    assert!(WorkspaceDescriptor::capture(directory.as_fd(), foreign).is_err());
    let path = fixture.0.join("file");
    fs::write(&path, b"not a directory").unwrap();
    let file = File::open(path).unwrap();
    assert!(WorkspaceDescriptor::capture(file.as_fd(), identity(&file)).is_err());
}
