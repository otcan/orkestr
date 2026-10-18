//! Read-only compile-time identity. No environment, filesystem or state reads.
//!
//! The producer supplies the entire record to retain it verbatim in the ELF.
//! Unpinned developer builds explicitly report an unknown source.
const VERSION: &str = env!("CARGO_PKG_VERSION");
pub static RECORD: &str = match option_env!("ORKESTR_V2_BUILD_IDENTITY") {
    Some(record) => record,
    None => concat!("ORKESTR_V2_BUILD_IDENTITY_V1|server|", env!("CARGO_PKG_VERSION"), "|unknown|END"),
};

fn source(record: &str, version: &str) -> Result<Option<String>, &'static str> {
    let parts: Vec<_> = record.split('|').collect();
    if parts.len() != 5 || parts[0] != "ORKESTR_V2_BUILD_IDENTITY_V1"
        || parts[1] != "server" || parts[2] != version || parts[4] != "END"
    {
        return Err("invalid embedded build identity");
    }
    if parts[3] == "unknown" {
        return Ok(None);
    }
    if parts[3].len() != 40 || !parts[3].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("invalid embedded source identity");
    }
    Ok(Some(parts[3].to_owned()))
}

pub fn identity() -> serde_json::Value {
    match source(RECORD, VERSION) {
        Ok(source) => serde_json::json!({"format":"orkestr-v2-build-identity-v1", "component":"server", "version":VERSION, "source_commit":source}),
        Err(error) => serde_json::json!({"format":"orkestr-v2-build-identity-v1", "component":"server", "version":VERSION, "source_commit":null, "error":error}),
    }
}

/// Call before HOME/config/bootstrap/database/listener initialization.
/// None means ordinary no-argument startup; unknown arguments must not start.
pub fn version_output(args: &[String]) -> Result<Option<String>, &'static str> {
    if args.is_empty() {
        return Ok(None);
    }
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["--version", "--json"] => {
            source(RECORD, VERSION)?;
            Ok(Some(identity().to_string()))
        },
        ["--version"] | ["-V"] => {
            let source = source(RECORD, VERSION)?.unwrap_or_else(|| "unknown".to_owned());
            Ok(Some(format!("orkestr-v2-server {VERSION} source={source}")))
        }
        _ => Err("supported arguments: --version [--json]"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_source_and_version_are_checked() {
        let sha = "a".repeat(40);
        let record = format!("ORKESTR_V2_BUILD_IDENTITY_V1|server|2.0.0-dev|{sha}|END");
        assert_eq!(source(&record, "2.0.0-dev"), Ok(Some(sha)));
        assert!(source(&record, "2.0.0-rc.1").is_err());
        assert!(source(&record.replace("server", "web"), "2.0.0-dev").is_err());
        assert!(source(&record.replace('a', "G"), "2.0.0-dev").is_err());
    }

    #[test]
    fn unpinned_source_is_explicit() {
        assert_eq!(source("ORKESTR_V2_BUILD_IDENTITY_V1|server|2.0.0-dev|unknown|END", "2.0.0-dev"), Ok(None));
    }

    #[test]
    fn arguments_never_fall_through_to_startup() {
        assert_eq!(version_output(&[]), Ok(None));
        assert!(version_output(&["--version".into()]).unwrap().is_some());
        let value: serde_json::Value = serde_json::from_str(&version_output(&["--version".into(), "--json".into()]).unwrap().unwrap()).unwrap();
        assert_eq!(value["version"], VERSION);
        assert!(version_output(&["--unknown".into()]).is_err());
    }
}
