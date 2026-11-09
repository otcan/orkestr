//! Passive, explicitly owner-bound V1 quota projection. Never contacts a provider.
use crate::{browser, desktop_broker::Broker, AppState, Error};
use axum::{
    extract::{RawQuery, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use orkestr_v2_contracts::OwnerId;
use serde::{Deserialize, Serialize};
use std::{os::unix::fs::MetadataExt, path::Path};

pub const CONFIG_ENV: &str = "ORKESTR_V2_PROVIDER_QUOTA_CONFIG";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    v1_url: String,
    bearer_token: String,
    owner_id: OwnerId,
    legacy_owner_id: String,
}
pub(crate) struct Source {
    broker: Broker,
    owner: OwnerId,
    legacy_owner: String,
}
impl Source {
    pub fn load(path: &Path) -> Result<Self, &'static str> {
        let meta = std::fs::symlink_metadata(path).map_err(|_| "quota config unreadable")?;
        if !meta.is_file()
            || meta.mode() & 0o077 != 0
            || meta.uid() != rustix::process::getuid().as_raw()
            || meta.len() > 8192
        {
            return Err("quota config must be a private regular file");
        }
        let cfg: Config =
            serde_json::from_slice(&std::fs::read(path).map_err(|_| "quota config unreadable")?)
                .map_err(|_| "quota config invalid")?;
        if cfg.owner_id.0.is_nil()
            || cfg.legacy_owner_id.is_empty()
            || cfg.legacy_owner_id.len() > 128
            || !cfg
                .legacy_owner_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        {
            return Err("explicit quota owner binding required");
        }
        Ok(Self {
            broker: Broker::new(&cfg.v1_url, cfg.bearer_token)?,
            owner: cfg.owner_id,
            legacy_owner: cfg.legacy_owner_id,
        })
    }
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    five_hour_remaining_pct: Option<f64>,
    weekly_remaining_pct: Option<f64>,
    five_hour_resets_at: Option<String>,
    weekly_resets_at: Option<String>,
    observed_at: Option<String>,
    #[serde(default)]
    stale: bool,
    #[serde(default)]
    limited: bool,
}
impl Provider {
    fn valid(&self) -> bool {
        [self.five_hour_remaining_pct, self.weekly_remaining_pct]
            .iter()
            .all(|v| v.is_none_or(|p| p.is_finite() && (0.0..=100.0).contains(&p)))
            && [
                &self.five_hour_resets_at,
                &self.weekly_resets_at,
                &self.observed_at,
            ]
            .iter()
            .all(|v| {
                v.as_ref().is_none_or(|s| {
                    !s.is_empty()
                        && s.len() <= 40
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || b"-:.TZ+".contains(&b))
                })
            })
    }
}
#[derive(Default, Deserialize, Serialize)]
struct Quotas {
    codex: Provider,
    claude: Provider,
}
#[derive(Deserialize, Serialize)]
struct Snapshot {
    quota: Quotas,
}
fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "quota_unavailable",
        "Provider quotas unavailable",
    )
}
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Result<Response, Error> {
    // Cookie-only owner session; no requested owner/account selector.
    let owner = browser::owner(&state, &headers).await?;
    if query.is_some() {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "quota_query_rejected",
            "Quota query rejected",
        ));
    }
    let source = state
        .provider_quota
        .as_ref()
        .filter(|s| s.owner == owner)
        .ok_or_else(unavailable)?;
    let (status, value) = source
        .broker
        .read(
            &format!("/api/quota/providers?ownerUserId={}", source.legacy_owner),
            16384,
        )
        .await
        .map_err(|_| unavailable())?;
    if status != 200 {
        return Err(unavailable());
    }
    let snapshot: Snapshot = serde_json::from_value(value).map_err(|_| unavailable())?;
    if !snapshot.quota.codex.valid() || !snapshot.quota.claude.valid() {
        return Err(unavailable());
    }
    // Revalidate after the bounded remote read, including session revocation.
    if browser::owner(&state, &headers).await? != owner {
        return Err(crate::unauthorized());
    }
    let mut response = Json(snapshot).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(response)
}
#[cfg(test)]
#[path = "provider_quota_http_tests.rs"]
mod http_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_drops_raw_telemetry_and_owner_fields() {
        let value = serde_json::json!({"quota":{"codex":{"fiveHourRemainingPct":42,"weeklyRemainingPct":8,"fiveHourResetsAt":null,"weeklyResetsAt":null,"observedAt":null,"stale":true,"limited":false,"account_ref":"private","source":"raw"},"claude":{}}});
        let snapshot: Snapshot = serde_json::from_value(value).unwrap();
        assert!(snapshot.quota.codex.valid());
        let text = serde_json::to_string(&snapshot).unwrap();
        assert!(!text.contains("private") && !text.contains("source"));
    }
    #[test]
    fn projection_rejects_invalid_numeric_and_text_fields() {
        let mut value = Provider {
            weekly_remaining_pct: Some(101.0),
            ..Provider::default()
        };
        assert!(!value.valid());
        value.weekly_remaining_pct = Some(0.0);
        assert!(value.valid());
        value.observed_at = Some("https://example.invalid/secret".into());
        assert!(!value.valid());
    }
}
