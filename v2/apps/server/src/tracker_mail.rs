//! Mail intake for a conversation tracker: read the local Thunderbird store
//! read-only (bounded, incremental, cursor in the tracker), classify with
//! the recipe's rule pack and record the result in one transaction.
//!
//! - `POST /api/v2/conversations/{id}/tracker/mail-scan` (owner or tracker
//!   grant): one scan; the report says whether anything is news.
//! - `GET|PUT /api/v2/conversations/{id}/tracker/mail-source` (owner): the
//!   source status, or set `{profile, folders}` (a change restarts the cursor).
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{conversation, failure, invalid};
use crate::recipes::{self, MailPart};
use crate::tracker_http::caller;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_mail_reader::{
    classify,
    profile::{discover, inbox_folders, sent_folders, DiscoveryEnv},
    scan_folders, Cursor, MailFolder, Outcome, ScanFolder, ScanLimits,
};
use orkestr_v2_store_sqlite::{ScannedMessage, TrackerConfig};
use std::path::PathBuf;
use std::time::SystemTime;

pub(crate) fn router() -> Router<AppState> {
    let base = "/api/v2/conversations/{id}/tracker";
    Router::new()
        .route(&format!("{base}/mail-scan"), post(scan_now))
        .route(&format!("{base}/mail-source"), get(source).put(set_source))
}

/// Stored mail source (`trackers.source_json`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct MailSource {
    pub mail: MailPart,
    /// Absolute profile directory; detected per OS when absent.
    #[serde(default)]
    pub profile: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceEdit {
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    folders: Vec<String>,
}

fn folder_label(folder: &MailFolder) -> String {
    match folder {
        MailFolder::Maildir(p) | MailFolder::Mbox(p) => p.display().to_string(),
    }
}

/// Resolve the profile and its folders (filesystem reads only): inboxes and
/// the user's Sent folders (the primary source of applications).
pub(crate) fn resolve(source: Option<&MailSource>) -> (TrackerMailStatus, Vec<ScanFolder>) {
    let Some(source) = source else {
        return (
            TrackerMailStatus { status: "not_configured".into(), profile: None, folders: vec![] },
            vec![],
        );
    };
    let profile = match &source.profile {
        Some(path) => Some(PathBuf::from(path)).filter(|p| p.is_dir()),
        None => discover(&DiscoveryEnv::from_process()).into_iter().next().map(|p| p.path),
    };
    let Some(profile) = profile else {
        return (
            TrackerMailStatus { status: "no_profile".into(), profile: source.profile.clone(), folders: vec![] },
            vec![],
        );
    };
    let inbox = inbox_folders(&profile, &source.mail.folders);
    let status = TrackerMailStatus {
        status: if inbox.is_empty() { "no_inbox" } else { "ready" }.into(),
        profile: Some(profile.display().to_string()),
        folders: vec![],
    };
    let folders: Vec<ScanFolder> = inbox
        .into_iter()
        .map(|folder| ScanFolder { folder, outgoing: false })
        .chain(sent_folders(&profile).into_iter().map(|folder| ScanFolder { folder, outgoing: true }))
        .collect();
    let status = TrackerMailStatus {
        folders: folders.iter().map(|f| folder_label(&f.folder)).collect(),
        ..status
    };
    (status, folders)
}

fn stored_source(config: &TrackerConfig) -> Option<MailSource> {
    config
        .source_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0))
}

/// Priority for the summary: offers and interviews first.
fn weight(change: &TrackerChange) -> u8 {
    match change.event {
        TrackerEventKind::Offer => 0,
        TrackerEventKind::InterviewInvite | TrackerEventKind::InterviewScheduled => 1,
        TrackerEventKind::Assessment => 2,
        TrackerEventKind::Rejection => 3,
        _ if change.kind == TrackerChangeKind::NeedsReview => 5,
        _ => 4,
    }
}

async fn scan_now(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let config = state
        .store
        .tracker_config(caller.store(), &conversation)
        .await
        .map_err(failure)?;
    let rules = recipes::find(&config.recipe)
        .and_then(|r| r.rules.as_ref())
        .ok_or(Error(StatusCode::CONFLICT, "tracker_without_rules", "This tracker's recipe has no mail rules"))?;
    let source = stored_source(&config);
    let cursor: Cursor = config
        .cursor_json
        .as_deref()
        .and_then(|c| serde_json::from_str(c).ok())
        .unwrap_or_default();
    let now = now_ms();
    let (status, envelopes, cursor, scan_stats) = {
        let source = source.clone();
        tokio::task::spawn_blocking(move || {
            let (status, folders) = resolve(source.as_ref());
            let Some(source) = source.filter(|_| !folders.is_empty()) else {
                return Ok::<_, std::io::Error>((status, vec![], cursor, Default::default()));
            };
            let limits = ScanLimits {
                max_messages: source.mail.max_messages_per_scan,
                not_before_ms: Some(now - i64::from(source.mail.since_days) * 86_400_000),
                max_seen: 50_000,
                ..ScanLimits::default()
            };
            let out = scan_folders(&folders, &cursor, &limits, SystemTime::now())?;
            Ok((status, out.envelopes, out.cursor, out.stats))
        })
        .await
        .map_err(|_| Error(StatusCode::SERVICE_UNAVAILABLE, "mail_scan_failed", "Mail scan failed"))?
        .map_err(|_| Error(StatusCode::SERVICE_UNAVAILABLE, "mail_store_unreadable", "The mail store could not be read"))?
    };
    let messages: Vec<ScannedMessage> = envelopes
        .iter()
        .map(|envelope| ScannedMessage {
            message_ref: envelope.message_ref.clone(),
            outcome: match classify(envelope, rules, now) {
                Outcome::Events { events, .. } => Ok(events),
                Outcome::Dropped { reason } => Err(reason),
            },
        })
        .collect();
    let stats = TrackerScanStats {
        folders: scan_stats.folders,
        new_messages: scan_stats.new_messages,
        skipped: scan_stats.skipped_large + scan_stats.skipped_old + scan_stats.skipped_unsettled + scan_stats.skipped_expunged,
        truncated: scan_stats.truncated,
        ..Default::default()
    };
    let cursor_json = serde_json::to_string(&cursor).map_err(|_| invalid())?;
    let summary_json = serde_json::to_string(&serde_json::json!({"status": status.status, "stats": stats}))
        .map_err(|_| invalid())?;
    let record = state
        .store
        .record_tracker_scan(caller.store(), &conversation, &messages, &cursor_json, &summary_json)
        .await
        .map_err(failure)?;
    let mut news: Vec<&TrackerChange> = record.changes.iter().filter(|c| c.is_news()).collect();
    news.sort_by_key(|c| weight(c));
    let report = TrackerScanReport {
        mail: status,
        news: !news.is_empty(),
        summary: news.iter().take(10).map(|c| c.line()).collect(),
        changes: record.changes.clone(),
        stats: TrackerScanStats {
            labelled: record.labelled,
            dropped: record.dropped,
            duplicates: record.duplicates,
            ..stats
        },
    };
    Ok(Json(report).into_response())
}

async fn source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let config = state
        .store
        .tracker_config(
            orkestr_v2_store_sqlite::TrackerCaller::Owner { credential: &credential, owner: &owner },
            &conversation(&id)?,
        )
        .await
        .map_err(failure)?;
    let source = stored_source(&config);
    let status = tokio::task::spawn_blocking(move || resolve(source.as_ref()).0)
        .await
        .map_err(|_| invalid())?;
    Ok(Json(status).into_response())
}

async fn set_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<SourceEdit>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let Json(edit) = request.map_err(|_| invalid())?;
    let folder_ok = |f: &String| !f.is_empty() && f.len() <= 120 && !f.contains(['/', '\\']) && f != ".." && !f.chars().any(char::is_control);
    if edit.profile.as_deref().is_some_and(|p| !valid_profile_path(p)) || edit.folders.len() > 8 || !edit.folders.iter().all(folder_ok) {
        return Err(invalid());
    }
    let owner_caller = orkestr_v2_store_sqlite::TrackerCaller::Owner { credential: &credential, owner: &owner };
    let config = state.store.tracker_config(owner_caller, &conversation).await.map_err(failure)?;
    let defaults = recipes::find(&config.recipe)
        .and_then(|r| r.manifest.mail.clone())
        .unwrap_or(MailPart { kind: "thunderbird".into(), folders: vec![], since_days: 60, max_messages_per_scan: 500 });
    let source = MailSource { mail: MailPart { folders: edit.folders, ..defaults }, profile: edit.profile };
    let json = serde_json::to_string(&source).map_err(|_| invalid())?;
    state
        .store
        .set_tracker_source(&credential, &owner, &conversation, Some(&json))
        .await
        .map_err(failure)?;
    let status = tokio::task::spawn_blocking(move || resolve(Some(&source)).0)
        .await
        .map_err(|_| invalid())?;
    Ok(Json(status).into_response())
}
