//! Operator-recorded activation times. Not service start times or artifact mtimes.
use orkestr_v2_contracts::build_times::timestamp;
use serde_json::{json, Value};
use std::sync::OnceLock;
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
pub fn identity() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| {
        let build = crate::build_identity::identity();
        let server = build["source_commit"].as_str().and_then(|source| {
            record(
                std::env::var("ORKESTR_V2_SERVER_DEPLOYED_SOURCE").ok(),
                std::env::var("ORKESTR_V2_SERVER_DEPLOYED_AT_UNIX").ok(),
                Some(source),
            )
        });
        // Web activation can differ from server activation. Browser validates its source.
        let web = record(
            std::env::var("ORKESTR_V2_WEB_DEPLOYED_SOURCE").ok(),
            std::env::var("ORKESTR_V2_WEB_DEPLOYED_AT_UNIX").ok(),
            None,
        );
        json!({"format":"orkestr-v2-deployment-times-v1","server":server,"web":web})
    })
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
}
