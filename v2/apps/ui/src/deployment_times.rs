//! Source-bound public deployment projection. Old servers remain explicitly unknown.
use orkestr_v2_contracts::build_times::display_timestamp;
use serde_json::Value;
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeploymentTimes {
    pub web: Option<u64>,
    pub server: Option<u64>,
}
fn component(value: &Value, source: Option<&str>) -> Option<u64> {
    let expected = source?;
    if value.get("source_commit")?.as_str()? != expected {
        return None;
    }
    let time = value.get("deployed_at_unix")?.as_u64()?;
    display_timestamp(time)?;
    Some(time)
}
pub fn parse(
    health: &Value,
    web_source: Option<&str>,
    server_source: Option<&str>,
) -> DeploymentTimes {
    let value = &health["deployment"];
    if value["format"] != "orkestr-v2-deployment-times-v1" {
        return DeploymentTimes::default();
    }
    DeploymentTimes {
        web: component(&value["web"], web_source),
        server: component(&value["server"], server_source),
    }
}
pub fn label(value: Option<u64>) -> String {
    value
        .and_then(display_timestamp)
        .unwrap_or_else(|| "Not recorded".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinct_web_server_and_stale_receipt() {
        let web = "a".repeat(40);
        let server = "b".repeat(40);
        let health = serde_json::json!({"deployment":{"format":"orkestr-v2-deployment-times-v1",
            "web":{"source_commit":web,"deployed_at_unix":1700000000},
            "server":{"source_commit":server,"deployed_at_unix":1700000200}}});
        let result = parse(&health, Some(&web), Some(&server));
        assert_eq!(result.web, Some(1700000000));
        assert_eq!(result.server, Some(1700000200));
        assert!(parse(&health, Some(&server), Some(&web)).web.is_none());
        assert_eq!(
            parse(&serde_json::json!({}), Some(&web), Some(&server)),
            DeploymentTimes::default()
        );
        let mut invalid = health;
        invalid["deployment"]["server"]["deployed_at_unix"] = serde_json::json!(-1);
        assert!(parse(&invalid, Some(&web), Some(&server)).server.is_none());
        invalid["deployment"]["server"]["deployed_at_unix"] = serde_json::json!(4102444800_u64);
        assert!(parse(&invalid, Some(&web), Some(&server)).server.is_none());
        assert_eq!(label(None), "Not recorded");
    }
}
