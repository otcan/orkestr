//! Root-recorded release interruptions (ORK-792).
//!
//! The release train records each Deep run it stops for a release, before the
//! Stop, as `<dir>/<run id>.json`: root-owned, not group or world writable,
//! one link. A fenced continuation of exactly that run in exactly that
//! conversation, at the recorded provider generation and before the record
//! expires, gets a grant for Core's one-time released-binding check
//! (`store-sqlite` `source_binding_released_once`). Anything else gets no
//! grant and keeps today's refusal. Core only reads; it never removes records.
//! Off unless the sealed configuration names `release_interruption_dir`.
use orkestr_v2_contracts::{ConversationId, RunId};
use orkestr_v2_store_sqlite::ReleasedContinuation;
use std::path::{Path, PathBuf};

const REFUSED: &str = "release interruption custody refused";
const FORMAT: &str = "orkestr-release-interruption-v1";
const MAX_RECORD: u64 = 4096;
/// Upper bound on a record's life, whatever its writer stated.
const MAX_WINDOW_MS: i64 = 2 * 60 * 60 * 1000;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    format: String,
    conversation_id: ConversationId,
    run_id: RunId,
    release_source: String,
    interrupted_at_ms: i64,
    provider_generation: i64,
    expires_at_ms: i64,
}

pub(crate) struct ReleaseInterruptions {
    dir: PathBuf,
    owner_uid: u32,
}

impl ReleaseInterruptions {
    pub(crate) fn bind(dir: &Path, home: &Path) -> Result<Self, &'static str> {
        Self::bind_owned(dir, home, 0)
    }

    fn bind_owned(dir: &Path, home: &Path, owner_uid: u32) -> Result<Self, &'static str> {
        if !crate::beta_config::conversation_workspace_path(dir) || dir.starts_with(home) {
            return Err(REFUSED);
        }
        protected_directory(dir, owner_uid)?;
        Ok(Self {
            dir: dir.to_owned(),
            owner_uid,
        })
    }

    /// The grant for a continuation of `run`, or None (today's behaviour).
    pub(crate) fn grant(
        &self,
        conversation: &ConversationId,
        run: &RunId,
        now_ms: i64,
    ) -> Option<ReleasedContinuation> {
        let record = self.read(run).ok()?;
        let source = &record.release_source;
        let valid = record.format == FORMAT
            && &record.conversation_id == conversation
            && &record.run_id == run
            && source.len() == 40
            && source
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && record.interrupted_at_ms > 0
            && record.provider_generation >= 0
            && record.expires_at_ms > record.interrupted_at_ms
            && record.expires_at_ms - record.interrupted_at_ms <= MAX_WINDOW_MS
            && now_ms <= record.expires_at_ms;
        valid.then(|| ReleasedContinuation {
            source_run_id: run.clone(),
            provider_generation: record.provider_generation,
        })
    }

    #[cfg(target_os = "linux")]
    fn read(&self, run: &RunId) -> Result<Record, &'static str> {
        use std::io::Read;
        use std::os::unix::fs::MetadataExt;
        protected_directory(&self.dir, self.owner_uid)?;
        let path = self.dir.join(format!("{}.json", run.0));
        // The final entry must be the regular file we then open: no link.
        let before = std::fs::symlink_metadata(&path).map_err(|_| REFUSED)?;
        if !before.file_type().is_file() {
            return Err(REFUSED);
        }
        let file = std::fs::File::open(&path).map_err(|_| REFUSED)?;
        let info = file.metadata().map_err(|_| REFUSED)?;
        if (info.dev(), info.ino()) != (before.dev(), before.ino())
            || !info.is_file()
            || info.uid() != self.owner_uid
            || info.nlink() != 1
            || info.mode() & 0o022 != 0
            || info.len() == 0
            || info.len() > MAX_RECORD
        {
            return Err(REFUSED);
        }
        let mut raw = Vec::new();
        file.take(MAX_RECORD + 1)
            .read_to_end(&mut raw)
            .map_err(|_| REFUSED)?;
        if raw.len() as u64 != info.len() {
            return Err(REFUSED);
        }
        serde_json::from_slice(&raw).map_err(|_| REFUSED)
    }

    #[cfg(not(target_os = "linux"))]
    fn read(&self, _: &RunId) -> Result<Record, &'static str> {
        Err(REFUSED)
    }
}

#[cfg(target_os = "linux")]
fn protected_directory(path: &Path, owner_uid: u32) -> Result<(), &'static str> {
    use std::os::unix::fs::MetadataExt;
    if std::fs::canonicalize(path).map_err(|_| REFUSED)? != path {
        return Err(REFUSED);
    }
    let own = std::fs::symlink_metadata(path).map_err(|_| REFUSED)?;
    if !own.is_dir() || own.uid() != owner_uid || own.mode() & 0o022 != 0 {
        return Err(REFUSED);
    }
    for ancestor in path.ancestors().skip(1) {
        let info = std::fs::symlink_metadata(ancestor).map_err(|_| REFUSED)?;
        let sticky_root = info.uid() == 0 && info.mode() & 0o1000 != 0;
        if !info.is_dir()
            || info.file_type().is_symlink()
            || (info.uid() != 0 && info.uid() != owner_uid)
            || (info.mode() & 0o022 != 0 && !sticky_root)
        {
            return Err(REFUSED);
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn protected_directory(_: &Path, _: u32) -> Result<(), &'static str> {
    Err(REFUSED)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use uuid::Uuid;

    const NOW: i64 = 1_800_000_000_000;

    struct Case {
        root: PathBuf,
        records: ReleaseInterruptions,
        dir: PathBuf,
        conversation: ConversationId,
        run: RunId,
    }

    fn case() -> Case {
        let root = std::env::temp_dir().join(format!("release-interruption-{}", Uuid::new_v4()));
        let dir = root.join("records");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o750)).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o750)).unwrap();
        let uid = std::fs::metadata(&dir).unwrap().uid();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let records =
            ReleaseInterruptions::bind_owned(&dir, Path::new("/synthetic-core-home"), uid).unwrap();
        Case {
            root,
            records,
            dir,
            conversation: ConversationId(Uuid::new_v4()),
            run: RunId(Uuid::new_v4()),
        }
    }

    fn write(case: &Case, value: serde_json::Value, mode: u32) {
        let path = case.dir.join(format!("{}.json", case.run.0));
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640));
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn record(case: &Case) -> serde_json::Value {
        serde_json::json!({
            "format": FORMAT, "conversation_id": case.conversation, "run_id": case.run,
            "release_source": "c".repeat(40), "interrupted_at_ms": NOW - 60_000,
            "provider_generation": 3, "expires_at_ms": NOW + 30 * 60_000,
        })
    }

    #[test]
    fn exact_unexpired_record_grants_its_run_and_provider_generation() {
        let case = case();
        write(&case, record(&case), 0o440);
        let grant = case
            .records
            .grant(&case.conversation, &case.run, NOW)
            .unwrap();
        assert_eq!(grant.source_run_id, case.run);
        assert_eq!(grant.provider_generation, 3);
        std::fs::remove_dir_all(&case.root).unwrap();
    }

    #[test]
    fn no_record_expired_or_foreign_records_grant_nothing() {
        let case = case();
        assert!(case
            .records
            .grant(&case.conversation, &case.run, NOW)
            .is_none());
        write(&case, record(&case), 0o440);
        let expiry = NOW + 30 * 60_000;
        assert!(case
            .records
            .grant(&case.conversation, &case.run, expiry + 1)
            .is_none());
        let other = ConversationId(Uuid::new_v4());
        assert!(case.records.grant(&other, &case.run, NOW).is_none());
        let mut value = record(&case);
        value["run_id"] = serde_json::json!(RunId(Uuid::new_v4()));
        write(&case, value, 0o440);
        assert!(case
            .records
            .grant(&case.conversation, &case.run, NOW)
            .is_none());
        std::fs::remove_dir_all(&case.root).unwrap();
    }

    #[test]
    fn invalid_records_grant_nothing() {
        let case = case();
        let mut long = record(&case);
        long["expires_at_ms"] = serde_json::json!(NOW - 60_000 + MAX_WINDOW_MS + 1);
        let mut extra = record(&case);
        extra["extra"] = serde_json::json!(true);
        let mut format = record(&case);
        format["format"] = serde_json::json!("other");
        let mut source = record(&case);
        source["release_source"] = serde_json::json!("short");
        for value in [long, extra, format, source] {
            write(&case, value, 0o440);
            assert!(case
                .records
                .grant(&case.conversation, &case.run, NOW)
                .is_none());
        }
        // Group-writable record, symlinked record, group-writable directory.
        write(&case, record(&case), 0o460);
        assert!(case
            .records
            .grant(&case.conversation, &case.run, NOW)
            .is_none());
        let path = case.dir.join(format!("{}.json", case.run.0));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        std::fs::remove_file(&path).unwrap();
        let target = case.root.join("elsewhere.json");
        std::fs::write(&target, serde_json::to_vec(&record(&case)).unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(case
            .records
            .grant(&case.conversation, &case.run, NOW)
            .is_none());
        std::fs::remove_file(&path).unwrap();
        write(&case, record(&case), 0o440);
        assert!(case
            .records
            .grant(&case.conversation, &case.run, NOW)
            .is_some());
        std::fs::set_permissions(&case.dir, std::fs::Permissions::from_mode(0o770)).unwrap();
        assert!(case
            .records
            .grant(&case.conversation, &case.run, NOW)
            .is_none());
        std::fs::set_permissions(&case.dir, std::fs::Permissions::from_mode(0o750)).unwrap();
        std::fs::remove_dir_all(&case.root).unwrap();
    }

    #[test]
    fn binding_refuses_relative_or_core_home_directories() {
        let case = case();
        let uid = std::fs::metadata(&case.dir).unwrap().uid();
        assert!(
            ReleaseInterruptions::bind_owned(Path::new("relative"), Path::new("/h"), uid).is_err()
        );
        assert!(ReleaseInterruptions::bind_owned(&case.dir, &case.root, uid).is_err());
        std::fs::remove_dir_all(&case.root).unwrap();
    }
}
