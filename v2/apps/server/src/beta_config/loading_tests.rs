use super::*;
use serde_json::{json, Value};
use std::io::Read;
use std::os::unix::{
    fs::{chown, symlink, PermissionsExt},
    net::UnixListener,
    process::CommandExt,
};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

// Synthetic unprivileged identity, deliberately unrelated to any installation.
const UID: u32 = 65534;
const GID: u32 = 65534;
const LAUNCHER: &[u8] = b"#!/bin/sh\nexit 99\n";

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    config: PathBuf,
    executable: PathBuf,
    value: Value,
    listener: Option<UnixListener>,
}
fn mode(path: &Path, value: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(value)).unwrap();
}
fn directory(path: &Path, uid: u32, gid: u32, permissions: u32) {
    fs::create_dir(path).unwrap();
    chown(path, Some(uid), Some(gid)).unwrap();
    mode(path, permissions);
}
impl Fixture {
    fn new() -> Self {
        assert_eq!(
            fs::metadata("/proc/self").unwrap().uid(),
            0,
            "explicit root fixture runner required"
        );
        // Hosted CI makes /opt world-writable. Own this synthetic ancestry
        // below /, like the manager fixture; never chmod a shared directory.
        let root = PathBuf::from(format!("/orkestr-beta-loading-test-{}", Uuid::new_v4()));
        directory(&root, 0, GID, 0o750);
        let home = root.join("home");
        directory(&home, UID, GID, 0o700);
        let workspace = root.join("workspace");
        directory(&workspace, UID, GID, 0o700);
        let endpoints = root.join("endpoints");
        directory(&endpoints, 0, GID, 0o750);
        let socket = endpoints.join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        chown(&socket, Some(0), Some(GID)).unwrap();
        mode(&socket, 0o660);
        let launcher = root.join("launcher");
        fs::write(&launcher, LAUNCHER).unwrap();
        chown(&launcher, Some(0), Some(GID)).unwrap();
        mode(&launcher, 0o550);
        let executable = root.join("test-executable");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        chown(&executable, Some(0), Some(GID)).unwrap();
        mode(&executable, 0o550);
        let value = json!({"schema_version":1,"owner_id":Uuid::from_u128(1),"conversation_id":Uuid::from_u128(2),
            "manager_socket":socket,"launcher":launcher,"launcher_sha256":format!("{:x}",Sha256::digest(LAUNCHER)),
            "workspace":workspace,"namespace":"synthetic-deep","supervisor_key":"synthetic-supervisor"});
        let fixture = Self {
            config: root.join("beta.json"),
            root,
            home,
            executable,
            value,
            listener: Some(listener),
        };
        fixture.write();
        fixture
    }
    fn write(&self) {
        fs::write(&self.config, serde_json::to_vec(&self.value).unwrap()).unwrap();
        chown(&self.config, Some(0), Some(GID)).unwrap();
        mode(&self.config, 0o640);
    }
    fn path(&self, key: &str) -> PathBuf {
        PathBuf::from(self.value[key].as_str().unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.listener.take();
        let _ = fs::remove_dir_all(&self.root);
    }
}
struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn exercise(case: &str) {
    let mut f = Fixture::new();
    let mut rewrite = false;
    if case.starts_with("conversation_") {
        let workspace = f.root.join("shared-thread");
        directory(&workspace, 0, GID, 0o755);
        let mut bytes = 2u32.to_le_bytes().to_vec();
        let user = if case == "conversation_other_uid" {
            UID - 1
        } else {
            UID
        };
        let mask = if case == "conversation_mask" { 5 } else { 7 };
        for (tag, perm, id) in [
            (1u16, 7u16, u32::MAX),
            (2, 7, user),
            (4, 5, u32::MAX),
            (16, mask, u32::MAX),
            (32, 5, u32::MAX),
        ] {
            bytes.extend(tag.to_le_bytes());
            bytes.extend(perm.to_le_bytes());
            bytes.extend(id.to_le_bytes());
        }
        if case != "conversation_no_acl" {
            rustix::fs::setxattr(
                &workspace,
                "system.posix_acl_access",
                &bytes,
                rustix::fs::XattrFlags::empty(),
            )
            .unwrap();
        }
        if case == "conversation_world_write" {
            mode(&workspace, 0o777);
        }
        let path = if case == "conversation_alias" {
            let alias = f.root.join("shared-alias");
            symlink(&workspace, &alias).unwrap();
            alias
        } else {
            workspace
        };
        let selected = if case == "conversation_no_optin" {
            json!(path)
        } else {
            json!({"path":path, "shared":true})
        };
        f.value["host_full_access"] =
            json!({"environment":{"HOME":"/home/example","PATH":"/usr/bin"}});
        f.value["conversation_workspaces"] = json!({Uuid::from_u128(2).to_string():selected});
        f.write();
    }
    match case {
        "valid" => {}
        value if value.starts_with("conversation_") => {}
        "world_executable" => {
            chown(f.path("launcher"), Some(0), Some(0)).unwrap();
            mode(&f.path("launcher"), 0o555);
        }
        "config_owner" => chown(&f.config, Some(UID), None).unwrap(),
        "config_group" => chown(&f.config, None, Some(GID - 1)).unwrap(),
        "config_mode" => mode(&f.config, 0o440),
        "config_write" => mode(&f.config, 0o660),
        "ancestor_write" => mode(&f.root, 0o770),
        "config_alias" => {
            let alias = f.root.join("alias.json");
            symlink(&f.config, &alias).unwrap();
            f.config = alias;
        }
        "config_lexical_alias" => {
            f.config = PathBuf::from(format!("{}/./beta.json", f.root.display()))
        }
        "config_link" => fs::hard_link(&f.config, f.root.join("second.json")).unwrap(),
        "config_bound" => File::options()
            .write(true)
            .open(&f.config)
            .unwrap()
            .set_len(8193)
            .unwrap(),
        "config_duplicate" => {
            let raw = fs::read_to_string(&f.config).unwrap();
            fs::write(&f.config, format!("{{\"schema_version\":1,{}", &raw[1..])).unwrap();
        }
        "config_bom" => {
            let mut bytes = vec![0xef, 0xbb, 0xbf];
            bytes.extend(fs::read(&f.config).unwrap());
            fs::write(&f.config, bytes).unwrap();
        }
        "config_authority" => {
            f.value["machine_token_file"] = json!("synthetic-forbidden");
            rewrite = true;
        }
        "launcher_hash" => fs::write(f.path("launcher"), b"synthetic changed bytes").unwrap(),
        "launcher_link" => {
            fs::hard_link(f.path("launcher"), f.root.join("second-launcher")).unwrap()
        }
        "launcher_alias" => {
            let alias = f.root.join("launcher-alias");
            symlink(f.path("launcher"), &alias).unwrap();
            f.value["launcher"] = json!(alias);
            rewrite = true;
        }
        "launcher_mode" => mode(&f.path("launcher"), 0o440),
        "launcher_special" => mode(&f.path("launcher"), 0o4550),
        "launcher_bound" => File::options()
            .write(true)
            .open(f.path("launcher"))
            .unwrap()
            .set_len(16 * 1024 * 1024 + 1)
            .unwrap(),
        "home_owner" => chown(&f.home, Some(0), None).unwrap(),
        "home_mode" => mode(&f.home, 0o750),
        "workspace_owner" => chown(f.path("workspace"), Some(0), None).unwrap(),
        "workspace_group" => chown(f.path("workspace"), None, Some(GID - 1)).unwrap(),
        "workspace_mode" => mode(&f.path("workspace"), 0o750),
        "workspace_overlap" => {
            f.value["workspace"] = json!(f.home);
            rewrite = true;
        }
        "workspace_nested" => {
            let nested = f.home.join("nested");
            directory(&nested, UID, GID, 0o700);
            f.value["workspace"] = json!(nested);
            rewrite = true;
        }
        "workspace_alias" => {
            let alias = f.root.join("workspace-alias");
            symlink(f.path("workspace"), &alias).unwrap();
            f.value["workspace"] = json!(alias);
            rewrite = true;
        }
        "socket_mode" => mode(&f.path("manager_socket"), 0o640),
        "socket_owner" => chown(f.path("manager_socket"), Some(UID), None).unwrap(),
        "socket_group" => chown(f.path("manager_socket"), None, Some(GID - 1)).unwrap(),
        "socket_parent" => mode(f.path("manager_socket").parent().unwrap(), 0o770),
        "socket_file" => {
            f.listener.take();
            let path = f.path("manager_socket");
            fs::remove_file(&path).unwrap();
            fs::write(&path, []).unwrap();
            chown(&path, Some(0), Some(GID)).unwrap();
            mode(&path, 0o660);
        }
        "socket_alias" => {
            let alias = f.root.join("control.sock");
            symlink(f.path("manager_socket"), &alias).unwrap();
            f.value["manager_socket"] = json!(alias);
            rewrite = true;
        }
        "socket_name" => {
            let renamed = f.root.join("endpoints/egress.sock");
            fs::rename(f.path("manager_socket"), &renamed).unwrap();
            f.value["manager_socket"] = json!(renamed);
            rewrite = true;
        }
        _ => panic!("unknown synthetic case"),
    }
    if rewrite {
        f.write();
    }
    let name = format!(
        "{}::fixture_child",
        module_path!().split_once("::").unwrap().1
    );
    let mut command = Command::new(&f.executable);
    command
        .args(["--exact", &name, "--nocapture"])
        .uid(UID)
        .gid(GID)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("ORKESTR_TEST_BETA_PATH", &f.config)
        .env("ORKESTR_TEST_BETA_HOME", &f.home)
        .env(
            "ORKESTR_TEST_BETA_EXPECT",
            if ["valid", "world_executable", "conversation_shared"].contains(&case) {
                "pass"
            } else {
                "refuse"
            },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Parallel fixture forks can inherit another fixture's copy writer until
    // exec closes its CLOEXEC fd. Only this transient Linux ETXTBSY is retried;
    // no beta validation or actual launcher refusal is retried or weakened.
    let spawn_deadline = Instant::now() + Duration::from_secs(3);
    let mut child = loop {
        match command.spawn() {
            Ok(child) => break Owned(child),
            Err(error) if error.raw_os_error() == Some(26) && Instant::now() < spawn_deadline => {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("synthetic custody fixture spawn failed: {error}"),
        }
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "fixture child deadline");
        std::thread::sleep(Duration::from_millis(2));
    };
    let mut output = String::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    child
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(status.success(), "{case}: {output}");
    assert!(!PathBuf::from(format!("/proc/{}", child.0.id())).exists());
}

#[test]
fn fixture_child() {
    let Ok(path) = std::env::var("ORKESTR_TEST_BETA_PATH") else {
        return;
    };
    let home = std::env::var("ORKESTR_TEST_BETA_HOME").unwrap();
    let expected = std::env::var("ORKESTR_TEST_BETA_EXPECT").unwrap();
    assert_eq!(identity().unwrap(), (UID, GID));
    let result = load(Path::new(&path), Path::new(&home));
    if expected == "pass" {
        let config = result.unwrap();
        assert_eq!(config.owner_id.0, Uuid::from_u128(1));
        assert_eq!(config.namespace, "synthetic-deep");
    } else {
        assert!(result.is_err(), "untrusted custody was accepted");
    }
}

#[test]
fn canonical_path_comparison_rejects_lexical_and_symlink_aliases() {
    let root = std::env::temp_dir().join(format!("beta-canonical-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let file = root.join("plain");
    fs::write(&file, b"synthetic").unwrap();
    let alias = root.join("alias");
    symlink(&file, &alias).unwrap();
    let outcomes = (
        canonical(&file).is_ok(),
        canonical(&alias).is_err(),
        canonical(&root.join("./plain")).is_err(),
    );
    fs::remove_dir_all(root).unwrap();
    assert_eq!(outcomes, (true, true, true));
}

#[test]
fn read_identity_detects_content_metadata_or_inode_replacement() {
    let root = std::env::temp_dir().join(format!("beta-identity-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let path = root.join("plain");
    fs::write(&path, b"synthetic").unwrap();
    let original = fs::metadata(&path).unwrap();
    assert!(same(&original, &fs::metadata(&path).unwrap()));
    fs::write(&path, b"different length").unwrap();
    assert!(!same(&original, &fs::metadata(&path).unwrap()));
    let next = root.join("next");
    fs::write(&next, b"synthetic").unwrap();
    fs::rename(&next, &path).unwrap();
    let changed = !same(&original, &fs::metadata(&path).unwrap());
    fs::remove_dir_all(root).unwrap();
    assert!(changed);
}

macro_rules! privileged {
    ($($name:ident=>$case:literal),+ $(,)?)=>{$(
        #[test]
        #[ignore="root custody fixture; run focused executable with --include-ignored"]
        fn $name(){exercise($case);}
    )+};
}
privileged! {
    valid_group_read_config=>"valid", protected_world_executable=>"world_executable",
    config_owner_refused=>"config_owner", config_group_refused=>"config_group", config_mode_refused=>"config_mode",
    config_write_refused=>"config_write", ancestor_write_refused=>"ancestor_write", config_symlink_refused=>"config_alias",
    config_lexical_alias_refused=>"config_lexical_alias", config_hardlink_refused=>"config_link", config_bound_refused=>"config_bound",
    duplicate_fields_refused=>"config_duplicate", utf8_bom_refused=>"config_bom", credential_field_refused=>"config_authority",
    launcher_hash_refused=>"launcher_hash", launcher_hardlink_refused=>"launcher_link", launcher_symlink_refused=>"launcher_alias",
    nonexecutable_refused=>"launcher_mode", setuid_launcher_refused=>"launcher_special", launcher_bound_refused=>"launcher_bound",
    home_owner_refused=>"home_owner", home_mode_refused=>"home_mode", workspace_owner_refused=>"workspace_owner",
    workspace_group_refused=>"workspace_group", workspace_mode_refused=>"workspace_mode", workspace_overlap_refused=>"workspace_overlap",
    workspace_nested_refused=>"workspace_nested", workspace_symlink_refused=>"workspace_alias", socket_mode_refused=>"socket_mode",
    socket_owner_refused=>"socket_owner", socket_group_refused=>"socket_group", socket_parent_refused=>"socket_parent",
    socket_regular_file_refused=>"socket_file", socket_symlink_refused=>"socket_alias", socket_name_refused=>"socket_name",
    conversation_shared_acl_allowed=>"conversation_shared", conversation_no_acl_refused=>"conversation_no_acl",
    conversation_no_optin_refused=>"conversation_no_optin", conversation_wrong_uid_refused=>"conversation_other_uid",
    conversation_mask_refused=>"conversation_mask", conversation_world_write_refused=>"conversation_world_write",
    conversation_symlink_refused=>"conversation_alias",
}
