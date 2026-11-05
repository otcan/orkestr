//! Local operator port. A root-created parent socket and the configured locked
//! ledger inode are required before any credential bytes or Core are read.
use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
use orkestr_v2_contracts::OwnerId;
use orkestr_v2_store_sqlite::{owner_password::PasswordChange, Store};
use serde::Deserialize;
use std::{os::fd::AsFd, os::unix::fs::MetadataExt, path::Path, time::Duration};
use tokio::io::AsyncReadExt;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    owner_id: String,
    username: String,
    password: String,
    revoke_legacy: bool,
    lock_device: u64,
    lock_inode: u64,
}

fn private_core(home: &Path) -> Result<(), &'static str> {
    let uid = rustix::process::geteuid().as_raw();
    if uid == 0 || !home.is_absolute() || home.canonicalize().ok().as_deref() != Some(home) {
        return Err("recovery_authority_required");
    }
    for path in home.ancestors() {
        let meta = std::fs::symlink_metadata(path).map_err(|_| "recovery_core_custody")?;
        let sticky_root = meta.uid() == 0 && meta.mode() & 0o1000 != 0;
        if !meta.is_dir()
            || ![0, uid].contains(&meta.uid())
            || (meta.mode() & 0o022 != 0 && !sticky_root)
        {
            return Err("recovery_core_custody");
        }
    }
    let directory = std::fs::symlink_metadata(home).map_err(|_| "recovery_core_custody")?;
    if directory.uid() != uid || directory.mode() & 0o777 != 0o700 {
        return Err("recovery_core_custody");
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        match std::fs::symlink_metadata(home.join(format!("core.sqlite3{suffix}"))) {
            Ok(meta) => {
                if !meta.is_file()
                    || meta.uid() != uid
                    || meta.nlink() != 1
                    || meta.mode() & 0o777 != 0o600
                    || (suffix.is_empty() && meta.len() == 0)
                {
                    return Err("recovery_core_custody");
                }
            }
            Err(error) if !suffix.is_empty() && error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("recovery_core_custody"),
        }
    }
    Ok(())
}

fn locked_descriptor(request: &Request) -> Result<rustix::fd::OwnedFd, &'static str> {
    let number: i32 = std::env::var("ORKESTR_V2_RECOVERY_LOCK_FD")
        .map_err(|_| "recovery_lock_required")?
        .parse()
        .map_err(|_| "recovery_lock_required")?;
    if !(3..1024).contains(&number)
        || std::fs::symlink_metadata(format!("/proc/self/fd/{number}")).is_err()
    {
        return Err("recovery_lock_required");
    }
    // SAFETY: the root operator supplies this inherited descriptor. /proc above
    // established it is open; no code owns/closes it in this recovery process.
    let borrowed = unsafe { rustix::fd::BorrowedFd::borrow_raw(number) };
    let lock = rustix::io::dup(borrowed).map_err(|_| "recovery_lock_required")?;
    let meta = rustix::fs::fstat(&lock).map_err(|_| "recovery_lock_custody")?;
    if rustix::fs::FileType::from_raw_mode(meta.st_mode) != rustix::fs::FileType::RegularFile
        || meta.st_uid != 0
        || meta.st_mode & 0o777 != 0o600
        || meta.st_nlink != 1
        || meta.st_dev != request.lock_device
        || meta.st_ino != request.lock_inode
    {
        return Err("recovery_lock_custody");
    }
    rustix::fs::flock(&lock, rustix::fs::FlockOperation::NonBlockingLockExclusive)
        .map_err(|_| "recovery_lock_busy")?;
    Ok(lock)
}

async fn request() -> Result<Request, &'static str> {
    let fd = rustix::io::dup(std::io::stdin().as_fd()).map_err(|_| "recovery_root_channel")?;
    let channel = std::os::unix::net::UnixStream::from(fd);
    channel
        .set_nonblocking(true)
        .map_err(|_| "recovery_root_channel")?;
    let channel = tokio::net::UnixStream::from_std(channel).map_err(|_| "recovery_root_channel")?;
    let peer = channel.peer_cred().map_err(|_| "recovery_root_channel")?;
    let parent = rustix::process::getppid().ok_or("recovery_root_parent")?;
    if peer.uid() != 0 || peer.pid() != Some(parent.as_raw_nonzero().get()) {
        return Err("recovery_root_parent");
    }
    rustix::process::set_parent_process_death_signal(Some(rustix::process::Signal::KILL))
        .map_err(|_| "recovery_root_parent")?;
    if rustix::process::getppid() != Some(parent) {
        return Err("recovery_root_parent");
    }
    let mut bytes = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(5),
        channel.take(4097).read_to_end(&mut bytes),
    )
    .await
    .map_err(|_| "recovery_request_deadline")?
    .map_err(|_| "recovery_request_unavailable")?;
    if bytes.len() > 4096 {
        return Err("recovery_request_bound");
    }
    serde_json::from_slice(&bytes).map_err(|_| "recovery_request_shape")
}

async fn change(home: &Path, request: Request) -> Result<(), &'static str> {
    if uuid::Uuid::parse_str(&request.owner_id).is_err()
        || request.username.is_empty()
        || request.username.len() > 128
        || !(12..=1024).contains(&request.password.len())
    {
        return Err("recovery_request_shape");
    }
    private_core(home)?;
    let _lock = locked_descriptor(&request)?;
    let store = Store::open_current(&home.join("core.sqlite3"))
        .await
        .map_err(|_| "recovery_core_unavailable")?;
    let owner = store
        .credentials(&request.username)
        .await
        .map_err(|_| "recovery_core_unavailable")?;
    if owner.as_ref().map(|record| record.0.to_string()).as_deref() != Some(&request.owner_id) {
        store.close().await;
        return Err("recovery_owner_mismatch");
    }
    let password = request.password;
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(
                password.as_bytes(),
                &SaltString::generate(&mut argon2::password_hash::rand_core::OsRng),
            )
            .map(|hash| hash.to_string())
    })
    .await
    .map_err(|_| "recovery_hash_unavailable")?
    .map_err(|_| "recovery_hash_unavailable")?;
    let expected_owner =
        OwnerId(uuid::Uuid::parse_str(&request.owner_id).map_err(|_| "recovery_request_shape")?);
    let result = store
        .recover_owner_password_bound(
            &expected_owner,
            &request.username,
            &hash,
            request.revoke_legacy,
        )
        .await
        .map_err(|_| "recovery_core_unavailable");
    store.close().await;
    match result? {
        PasswordChange::Changed => Ok(()),
        PasswordChange::LegacySessions => Err("recovery_legacy_sessions_present"),
        _ => Err("recovery_refused"),
    }
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let result = async {
        let request = request().await?;
        let home = std::env::var_os("ORKESTR_V2_HOME").ok_or("recovery_core_required")?;
        change(Path::new(&home), request).await
    }
    .await;
    match result {
        Ok(()) => {
            println!("{{\"status\":\"changed\",\"browser_sessions_revoked\":true,\"machine_credentials_preserved\":true}}");
            Ok(())
        }
        Err(code) => {
            println!("{}", serde_json::json!({"status":"refused","code":code}));
            Err("owner password recovery refused".into())
        }
    }
}

#[cfg(test)]
#[path = "password_recovery_tests.rs"]
mod tests;
