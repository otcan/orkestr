//! Compile-time web identity retained by its rendered About record, not a sidecar.
use serde::Serialize;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub static RECORD: &str = match option_env!("ORKESTR_V2_BUILD_IDENTITY") {
    Some(record) => record,
    None => concat!(
        "ORKESTR_V2_BUILD_IDENTITY_V1|web|",
        env!("CARGO_PKG_VERSION"),
        "|unknown|END"
    ),
};

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Identity<'a> {
    pub format: &'static str,
    pub component: &'static str,
    pub version: &'a str,
    pub source_commit: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

pub fn parse<'a>(record: &'a str, version: &'a str) -> Identity<'a> {
    let parts: Vec<_> = record.split('|').collect();
    let valid = parts.len() == 5
        && parts[0] == "ORKESTR_V2_BUILD_IDENTITY_V1"
        && parts[1] == "web"
        && parts[2] == version
        && parts[4] == "END";
    let source = valid.then(|| parts[3]);
    let valid_source = source.is_some_and(|s| {
        s == "unknown"
            || (s.len() == 40
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    });
    Identity {
        format: "orkestr-v2-build-identity-v1",
        component: "web",
        version,
        source_commit: source.filter(|s| *s != "unknown" && valid_source),
        error: (!valid_source).then_some("Invalid embedded web build identity"),
    }
}

pub fn compiled_at() -> Option<u64> {
    option_env!("ORKESTR_V2_COMPILED_AT_UNIX").and_then(orkestr_v2_contracts::build_times::timestamp)
}

pub fn identity() -> Identity<'static> {
    parse(RECORD, VERSION)
}

/// Validated runtime identity, separate from the assets executing in this tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerIdentity {
    pub version: String,
    pub source_commit: Option<String>,
    pub compiled_at_unix: Option<u64>,
}

pub fn server_identity(health: &serde_json::Value) -> Option<ServerIdentity> {
    let build = health.get("build")?;
    let version = build.get("version")?.as_str()?;
    if health.get("status")?.as_str()? != "ok"
        || health.get("product")?.as_str()? != "orkestr-v2"
        || build.get("format")?.as_str()? != "orkestr-v2-build-identity-v1"
        || build.get("component")?.as_str()? != "server"
        || build.get("error").is_some()
        || version.is_empty()
        || version.len() > 128
        || version.chars().any(char::is_control)
    {
        return None;
    }
    let source_commit = match build.get("source_commit")? {
        serde_json::Value::Null => None,
        serde_json::Value::String(source)
            if source.len() == 40
                && source
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            Some(source.clone())
        }
        _ => return None,
    };
    Some(ServerIdentity {
        version: version.into(),
        source_commit,
        compiled_at_unix: build.get("compiled_at_unix").and_then(|v| v.as_u64()).filter(|v| orkestr_v2_contracts::build_times::display_timestamp(*v).is_some()),
    })
}
