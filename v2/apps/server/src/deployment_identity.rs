//! Operator-recorded activation times. Not service start times or artifact mtimes.
//!
//! Two sources, both protected deployment configuration: a root-owned record file the release
//! train rewrites at each activation (read on every request, because web activation happens
//! after the server process starts), and the original process environment as a fallback.
use orkestr_v2_contracts::build_times::timestamp;
use serde_json::{json, Value};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
fn record(source: Option<String>, time: Option<String>, expected: Option<&str>) -> Option<Value> {
    let source = source?;
    if source.len() != 40
        || !source
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || expected.is_some_and(|expected| expected != source)
    {
        return None;
    }
    let deployed_at_unix = timestamp(&time?)?;
    Some(json!({"source_commit":source,"deployed_at_unix":deployed_at_unix}))
}
/// Env override for the record path (tests and rehearsals); the default is the control directory.
pub const RECORD_ENV: &str = "ORKESTR_V2_DEPLOYMENT_RECORD";
pub const DEFAULT_RECORD: &str = "/var/lib/orkestr-v2-control/deployment-times.json";
const RECORD_FORMAT: &str = "orkestr-v2-deployment-record-v1";
const RECORD_LIMIT: u64 = 64 * 1024;
fn file_part(entry: Option<&Value>, expected: Option<&str>) -> Option<Value> {
    let entry = entry?;
    let time = entry.get("deployed_at_unix")?.as_u64()?.to_string();
    record(
        entry.get("source_commit")?.as_str().map(str::to_owned),
        Some(time),
        expected,
    )
}
/// Read the train's record. It must be a regular file, not group/world writable, and (outside
/// tests) owned by `trusted_uid`; anything else is ignored, never partially trusted.
fn read_file(path: &Path, trusted_uid: Option<u32>) -> Option<Value> {
    let link = std::fs::symlink_metadata(path).ok()?;
    if !link.file_type().is_file() || link.mode() & 0o022 != 0 || link.len() > RECORD_LIMIT {
        return None;
    }
    if trusted_uid.is_some_and(|uid| link.uid() != uid) {
        return None;
    }
    let value: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (value.get("format")?.as_str()? == RECORD_FORMAT).then_some(value)
}
fn build(file: Option<&Value>, server_source: Option<&str>) -> Value {
    let server = file
        .and_then(|f| file_part(f.get("server"), server_source))
        .or_else(|| {
            record(
                std::env::var("ORKESTR_V2_SERVER_DEPLOYED_SOURCE").ok(),
                std::env::var("ORKESTR_V2_SERVER_DEPLOYED_AT_UNIX").ok(),
                server_source,
            )
        });
    // Web activation can differ from server activation. Browser validates its source.
    let web = file
        .and_then(|f| file_part(f.get("web"), None))
        .or_else(|| {
            record(
                std::env::var("ORKESTR_V2_WEB_DEPLOYED_SOURCE").ok(),
                std::env::var("ORKESTR_V2_WEB_DEPLOYED_AT_UNIX").ok(),
                None,
            )
        });
    json!({"format":"orkestr-v2-deployment-times-v1","server":server,"web":web})
}
pub fn identity() -> Value {
    let path = std::env::var(RECORD_ENV).unwrap_or_else(|_| DEFAULT_RECORD.to_string());
    let trusted = if std::env::var_os(RECORD_ENV).is_some() {
        None
    } else {
        Some(0)
    };
    let file = read_file(Path::new(&path), trusted);
    let build_identity = crate::build_identity::identity();
    build(file.as_ref(), build_identity["source_commit"].as_str())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_requires_source_and_timestamp_and_server_match() {
        let source = "a".repeat(40);
        assert!(record(Some(source.clone()), None, Some(&source)).is_none());
        assert!(record(
            Some(source.clone()),
            Some("not-a-time".into()),
            Some(&source)
        )
        .is_none());
        assert!(record(
            Some(source.clone()),
            Some("1700000000".into()),
            Some(&"b".repeat(40))
        )
        .is_none());
        assert_eq!(
            record(
                Some(source.clone()),
                Some("1700000000".into()),
                Some(&source)
            )
            .unwrap()["deployed_at_unix"],
            1700000000_u64
        );
        assert!(record(Some("not-a-source".into()), Some("1700000000".into()), None).is_none());
    }
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("deployment-record-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn write(dir: &Path, body: &str, mode: u32) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("deployment-times.json");
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }
    fn body(server: &str, web: &str) -> String {
        format!(
            r#"{{"format":"{RECORD_FORMAT}","server":{{"source_commit":"{server}","deployed_at_unix":1700000100}},"web":{{"source_commit":"{web}","deployed_at_unix":1700000200}}}}"#
        )
    }
    #[test]
    fn record_file_supplies_web_and_server_times_when_sources_match() {
        let dir = Scratch::new();
        let (a, b) = ("a".repeat(40), "b".repeat(40));
        let path = write(dir.path(), &body(&a, &b), 0o640);
        let file = read_file(&path, None);
        let value = build(file.as_ref(), Some(&a));
        assert_eq!(value["server"]["deployed_at_unix"], 1700000100_u64);
        assert_eq!(value["web"]["source_commit"], b.as_str());
        assert_eq!(value["web"]["deployed_at_unix"], 1700000200_u64);
    }
    #[test]
    fn stale_server_record_is_not_shown_for_different_running_code() {
        let dir = Scratch::new();
        let path = write(dir.path(), &body(&"a".repeat(40), &"b".repeat(40)), 0o640);
        let value = build(read_file(&path, None).as_ref(), Some(&"c".repeat(40)));
        assert!(value["server"].is_null());
        assert!(value["web"].is_object());
    }
    #[test]
    fn writable_foreign_or_malformed_record_files_are_ignored() {
        let dir = Scratch::new();
        let text = body(&"a".repeat(40), &"b".repeat(40));
        assert!(read_file(&write(dir.path(), &text, 0o666), None).is_none());
        let owned = write(dir.path(), &text, 0o640);
        let me = std::fs::metadata(&owned).unwrap().uid();
        assert!(read_file(&owned, Some(me)).is_some());
        assert!(read_file(&owned, Some(me + 1)).is_none());
        assert!(read_file(&write(dir.path(), "{not json", 0o640), None).is_none());
        assert!(read_file(&write(dir.path(), r#"{"format":"other"}"#, 0o640), None).is_none());
        assert!(read_file(&dir.path().join("missing.json"), None).is_none());
    }
}
