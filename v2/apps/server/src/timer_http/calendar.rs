//! Calendar and event timers: create, edit the rule, policy (silent mode,
//! pause, skip dates, digest, trigger), conversation pause, run outcomes,
//! digests and trigger events. Owner API only; the delivery adapter uses the
//! same credential as for `timer-inputs`. No clock, generation or claim is ever
//! taken from a request except the claim id of a run the adapter relays.
use super::*;
use orkestr_v2_contracts::{CalendarRule, ConversationId};
use orkestr_v2_store_sqlite::history_import::timers::{
    calendar_timer::{preview_schedule, CalendarTimerCreate},
    digest::TimerDigest,
    local_time_label,
    policy::{PolicyUpdate, TimerPolicy, TriggerSource},
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeSchedule {
    Calendar {
        timezone: String,
        #[serde(default)]
        weekdays: Vec<u8>,
        start_minute: u16,
        end_minute: u16,
        #[serde(default = "one")]
        every_hours: u8,
        minutes: Vec<u8>,
    },
    Event,
}
fn one() -> u8 {
    1
}
impl NativeSchedule {
    fn into_schedule(self) -> Result<TimerSchedule, Error> {
        Ok(match self {
            Self::Event => TimerSchedule::Event,
            Self::Calendar {
                timezone,
                weekdays,
                start_minute,
                end_minute,
                every_hours,
                minutes,
            } => TimerSchedule::Calendar(
                CalendarRule {
                    timezone,
                    weekdays,
                    start_minute,
                    end_minute,
                    every_hours,
                    minutes,
                }
                .normalized()
                .map_err(|_| error(HistoryError::Invalid))?,
            ),
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub namespace: Uuid,
    pub conversation_id: ConversationId,
    pub label: String,
    pub schedule: NativeSchedule,
    #[serde(default = "default_policy")]
    pub policy: PolicyUpdate,
    /// The instruction every run receives. When present the timer is enabled
    /// (a durable owner grant); without it the timer is created paused.
    pub text: Option<String>,
}
fn default_policy() -> PolicyUpdate {
    PolicyUpdate {
        silent_mode: Default::default(),
        pause_until_ms: None,
        skip_dates: Vec::new(),
        skip_timezone: None,
        digest: None,
        trigger: None,
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    pub expected_revision: i64,
    pub schedule: NativeSchedule,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyPut {
    pub expected_revision: i64,
    pub policy: PolicyUpdate,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pause {
    pub until_ms: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preview {
    pub schedule: NativeSchedule,
    pub from_ms: Option<i64>,
    pub count: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub source: TriggerSource,
    pub event_key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutcomeBody {
    pub claim_id: Uuid,
    pub text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DigestQuery {
    pub state: Option<String>,
    pub limit: Option<u16>,
}

#[derive(Serialize)]
pub struct Digest {
    pub id: Uuid,
    pub namespace: Uuid,
    pub slot_ms: i64,
    pub text: String,
    pub item_count: i64,
    pub created_ms: i64,
    pub delivered_ms: Option<i64>,
}
pub fn digest(value: TimerDigest) -> Digest {
    Digest {
        id: value.id,
        namespace: value.namespace,
        slot_ms: value.slot_ms,
        text: value.text,
        item_count: value.item_count,
        created_ms: value.created_ms,
        delivered_ms: value.delivered_ms,
    }
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0))
}
fn conversation_id(id: &str) -> Result<ConversationId, Error> {
    Uuid::parse_str(id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or_else(|| error(HistoryError::Invalid))
}

pub(super) async fn create(
    State(s): State<AppState>,
    Extension(c): Extension<DurableOwnerController>,
    headers: HeaderMap,
    value: Result<Json<Create>, JsonRejection>,
) -> Result<Json<dto::Detail>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let body = body(value)?;
    if body.namespace.is_nil() {
        return Err(error(HistoryError::Invalid));
    }
    let receipt = s
        .store
        .create_calendar_timer(
            &credential,
            &owner,
            &CalendarTimerCreate {
                namespace: body.namespace,
                conversation_id: body.conversation_id.clone(),
                label: body.label,
                schedule: body.schedule.into_schedule()?,
                policy: body.policy,
            },
        )
        .await
        .map_err(error)?;
    if let (Some(text), TimerState::Paused) = (body.text, receipt.state) {
        c.enable(
            credential.clone(),
            owner.clone(),
            body.namespace,
            dto::Enable {
                expected_revision: receipt.revision,
                request_key: format!("calendar-enable:{}", body.namespace),
                conversation_id: body.conversation_id,
                text,
            },
        )
        .await
        .map_err(error)?;
    }
    let value = s
        .store
        .dormant_timer_detail(&credential, &owner, body.namespace)
        .await
        .map_err(error)?;
    Ok(Json(detail(&c, value).await))
}

pub(super) async fn edit(
    State(s): State<AppState>,
    Extension(c): Extension<DurableOwnerController>,
    headers: HeaderMap,
    Path(id): Path<String>,
    value: Result<Json<Edit>, JsonRejection>,
) -> Result<Json<dto::Detail>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let namespace = namespace(id)?;
    let body = body(value)?;
    s.store
        .update_calendar_schedule(
            &credential,
            &owner,
            namespace,
            body.expected_revision,
            &body.schedule.into_schedule()?,
        )
        .await
        .map_err(error)?;
    let value = s
        .store
        .dormant_timer_detail(&credential, &owner, namespace)
        .await
        .map_err(error)?;
    Ok(Json(detail(&c, value).await))
}

#[derive(Serialize)]
pub struct Previewed {
    pub summary: Option<String>,
    pub runs_ms: Vec<i64>,
    /// The same runs in the rule's own zone.
    pub runs_local: Vec<String>,
}
pub(super) async fn preview(
    State(s): State<AppState>,
    headers: HeaderMap,
    value: Result<Json<Preview>, JsonRejection>,
) -> Result<Json<Previewed>, Error> {
    owner_credential(&s, &headers).await?;
    let body = body(value)?;
    let schedule = body.schedule.into_schedule()?;
    let summary = match &schedule {
        TimerSchedule::Calendar(rule) => Some(rule.describe()),
        _ => None,
    };
    let runs_ms = preview_schedule(
        &schedule,
        body.from_ms.unwrap_or_else(now_ms),
        body.count.unwrap_or(5),
    )
    .map_err(error)?;
    let runs_local = match &schedule {
        TimerSchedule::Calendar(rule) => runs_ms
            .iter()
            .filter_map(|at| local_time_label(&rule.timezone, *at))
            .collect(),
        _ => Vec::new(),
    };
    Ok(Json(Previewed {
        summary,
        runs_ms,
        runs_local,
    }))
}

pub(super) async fn policy_read(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<TimerPolicy>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    Ok(Json(
        s.store
            .timer_policy(&credential, &owner, namespace(id)?)
            .await
            .map_err(error)?,
    ))
}
pub(super) async fn policy_put(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    value: Result<Json<PolicyPut>, JsonRejection>,
) -> Result<Json<TimerPolicy>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let namespace = namespace(id)?;
    let body = body(value)?;
    Ok(Json(
        s.store
            .set_timer_policy(
                &credential,
                &owner,
                namespace,
                body.expected_revision,
                &body.policy,
            )
            .await
            .map_err(error)?,
    ))
}
pub(super) async fn pause_timer(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    value: Result<Json<Pause>, JsonRejection>,
) -> Result<Json<TimerPolicy>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let namespace = namespace(id)?;
    let body = body(value)?;
    Ok(Json(
        s.store
            .pause_timer(&credential, &owner, namespace, body.until_ms)
            .await
            .map_err(error)?,
    ))
}

#[derive(Serialize)]
pub struct ConversationPause {
    pub pause_until_ms: Option<i64>,
}
pub(super) async fn pause_conversation(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    value: Result<Json<Pause>, JsonRejection>,
) -> Result<Json<ConversationPause>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let conversation = conversation_id(&id)?;
    let body = body(value)?;
    let pause_until_ms = s
        .store
        .pause_conversation_timers(&credential, &owner, &conversation, body.until_ms)
        .await
        .map_err(error)?;
    Ok(Json(ConversationPause { pause_until_ms }))
}

#[derive(Serialize)]
pub struct Triggered {
    pub accepted: u32,
}
pub(super) async fn trigger(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    value: Result<Json<Trigger>, JsonRejection>,
) -> Result<Json<Triggered>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let conversation = conversation_id(&id)?;
    let body = body(value)?;
    let accepted = s
        .store
        .record_timer_trigger(
            &credential,
            &owner,
            &conversation,
            body.source,
            &body.event_key,
        )
        .await
        .map_err(error)?;
    Ok(Json(Triggered { accepted }))
}

#[derive(Serialize)]
pub struct Outcome {
    pub outcome: &'static str,
    /// Whether the answer should be sent to the chat.
    pub deliver: bool,
    pub summary: String,
    pub replay: bool,
}
pub(super) async fn outcome(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    value: Result<Json<OutcomeBody>, JsonRejection>,
) -> Result<Json<Outcome>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let conversation = conversation_id(&id)?;
    let body = body(value)?;
    let recorded = s
        .store
        .record_timer_outcome(
            &credential,
            &owner,
            &conversation,
            body.claim_id,
            &body.text,
        )
        .await
        .map_err(error)?;
    Ok(Json(Outcome {
        outcome: recorded.kind.text(),
        deliver: recorded.kind.deliver(),
        summary: recorded.summary,
        replay: recorded.replay,
    }))
}

#[derive(Serialize)]
pub struct Digests {
    pub digests: Vec<Digest>,
}
pub(super) async fn digests(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<DigestQuery>, QueryRejection>,
) -> Result<Json<Digests>, Error> {
    let query = query.map_err(|_| error(HistoryError::Invalid))?.0;
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let conversation = conversation_id(&id)?;
    let limit = query.limit.unwrap_or(20);
    let rows = match query.state.as_deref() {
        None | Some("pending") => {
            s.store
                .pending_timer_digests(&credential, &owner, &conversation, limit)
                .await
        }
        Some("recent") => {
            s.store
                .recent_timer_digests(&credential, &owner, &conversation, limit)
                .await
        }
        Some(_) => return Err(error(HistoryError::Invalid)),
    }
    .map_err(error)?;
    Ok(Json(Digests {
        digests: rows.into_iter().map(digest).collect(),
    }))
}
#[derive(Serialize)]
pub struct Delivered {
    pub delivered: bool,
}
pub(super) async fn digest_delivered(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((id, digest)): Path<(String, String)>,
) -> Result<Json<Delivered>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let conversation = conversation_id(&id)?;
    s.store
        .acknowledge_timer_digest(&credential, &owner, &conversation, namespace(digest)?)
        .await
        .map_err(error)?;
    Ok(Json(Delivered { delivered: true }))
}
