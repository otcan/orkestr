//! Owner routes for moving a V1 thread's timers into a conversation: dormant
//! import with an immutable conversation mapping, a per-conversation listing,
//! and the timer-produced inputs a delivery adapter relays. Nothing here
//! enables a timer or grants execution; enable remains the explicit route.
use super::*;
use orkestr_v2_contracts::ConversationId;
use orkestr_v2_store_sqlite::history_import::timers::{
    DormantTimerReason, TimerImportRequest, TimerInputRecord, TimerListing, TimerTarget,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScheduleInput {
    Once {
        due_ms: i64,
    },
    Interval {
        every_ms: i64,
    },
    UtcClock {
        weekly: bool,
        minute_of_day: u16,
    },
    ZonedClock {
        timezone: String,
        weekday: Option<u8>,
        minute_of_day: u16,
    },
    Dormant {
        cadence: String,
        timezone: Option<String>,
        time: Option<String>,
        every: Option<String>,
        run_at: Option<String>,
        reason: Reason,
    },
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    MissingTimezone,
    UnsupportedTimezone,
    AmbiguousCadence,
    UncertainEffects,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Import {
    pub namespace: Uuid,
    pub source_namespace: String,
    pub source_timer_id: String,
    pub source_enabled: bool,
    pub schedule: ScheduleInput,
    pub conversation_id: ConversationId,
    pub label: String,
    pub source_thread_id: String,
}
#[derive(Serialize)]
pub struct Listed {
    #[serde(flatten)]
    pub detail: dto::Detail,
    pub label: Option<String>,
    pub source_thread_id: Option<String>,
    pub source_namespace: String,
    pub source_timer_id: String,
    pub source_enabled: bool,
}
#[derive(Serialize)]
pub struct Listing {
    pub conversation_id: ConversationId,
    pub timers: Vec<Listed>,
}
#[derive(Serialize)]
pub struct Input {
    pub namespace: Uuid,
    pub claim_id: Uuid,
    pub generation: i64,
    pub due_ms: i64,
    pub message_id: String,
    pub event_id: String,
    pub sequence: i64,
    pub request_key: String,
    pub label: Option<String>,
    pub source_timer_id: String,
    pub held: bool,
    pub window: Option<String>,
}
#[derive(Serialize)]
pub struct Inputs {
    pub conversation_id: ConversationId,
    pub inputs: Vec<Input>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputQuery {
    pub after_sequence: Option<i64>,
    pub limit: Option<u16>,
}

fn schedule(value: ScheduleInput) -> TimerSchedule {
    match value {
        ScheduleInput::Once { due_ms } => TimerSchedule::Once { due_ms },
        ScheduleInput::Interval { every_ms } => TimerSchedule::Interval { every_ms },
        ScheduleInput::UtcClock {
            weekly,
            minute_of_day,
        } => TimerSchedule::UtcClock {
            weekly,
            minute_of_day,
        },
        ScheduleInput::ZonedClock {
            timezone,
            weekday,
            minute_of_day,
        } => TimerSchedule::ZonedClock {
            timezone,
            weekday,
            minute_of_day,
        },
        ScheduleInput::Dormant {
            cadence,
            timezone,
            time,
            every,
            run_at,
            reason,
        } => TimerSchedule::Dormant {
            cadence,
            timezone,
            time,
            every,
            run_at,
            reason: match reason {
                Reason::MissingTimezone => DormantTimerReason::MissingTimezone,
                Reason::UnsupportedTimezone => DormantTimerReason::UnsupportedTimezone,
                Reason::AmbiguousCadence => DormantTimerReason::AmbiguousCadence,
                Reason::UncertainEffects => DormantTimerReason::UncertainEffects,
            },
        },
    }
}
fn conversation(id: &str) -> Result<ConversationId, Error> {
    Uuid::parse_str(id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or_else(|| error(HistoryError::Invalid))
}
async fn listed(controller: &DurableOwnerController, value: TimerListing) -> Listed {
    Listed {
        detail: detail(controller, value.detail).await,
        label: value.label,
        source_thread_id: value.source_thread_id,
        source_namespace: value.source_namespace,
        source_timer_id: value.source_timer_id,
        source_enabled: value.source_enabled,
    }
}
fn input(value: TimerInputRecord) -> Input {
    Input {
        namespace: value.namespace,
        claim_id: value.claim_id,
        generation: value.generation,
        due_ms: value.due_ms,
        message_id: value.message_id,
        event_id: value.event_id,
        sequence: value.sequence,
        request_key: value.request_key,
        label: value.label,
        source_timer_id: value.source_timer_id,
        held: value.held,
        window: value.window,
    }
}

pub(super) async fn import(
    State(s): State<AppState>,
    Extension(c): Extension<DurableOwnerController>,
    headers: HeaderMap,
    query: Result<Query<dto::Read>, QueryRejection>,
    value: Result<Json<Import>, JsonRejection>,
) -> Result<Json<dto::Detail>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    query.map_err(|_| error(HistoryError::Invalid))?;
    let body = body(value)?;
    if body.namespace.is_nil() {
        return Err(error(HistoryError::Invalid));
    }
    let receipt = s
        .store
        .import_dormant_timer_for(
            &credential,
            &owner,
            &TimerImportRequest {
                namespace: body.namespace,
                source_namespace: body.source_namespace,
                source_timer_id: body.source_timer_id,
                source_enabled: body.source_enabled,
                schedule: schedule(body.schedule),
            },
            &TimerTarget {
                conversation_id: body.conversation_id,
                label: body.label,
                source_thread_id: body.source_thread_id,
            },
        )
        .await
        .map_err(error)?;
    let value = s
        .store
        .dormant_timer_detail(&credential, &owner, receipt.namespace)
        .await
        .map_err(error)?;
    Ok(Json(detail(&c, value).await))
}

pub(super) async fn list(
    State(s): State<AppState>,
    Extension(c): Extension<DurableOwnerController>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<dto::Read>, QueryRejection>,
) -> Result<Json<Listing>, Error> {
    query.map_err(|_| error(HistoryError::Invalid))?;
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let conversation = conversation(&id)?;
    let rows = s
        .store
        .conversation_timers(&credential, &owner, &conversation)
        .await
        .map_err(error)?;
    let mut timers = Vec::with_capacity(rows.len());
    for row in rows {
        timers.push(listed(&c, row).await);
    }
    Ok(Json(Listing {
        conversation_id: conversation,
        timers,
    }))
}

pub(super) async fn inputs(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<InputQuery>, QueryRejection>,
) -> Result<Json<Inputs>, Error> {
    let query = query.map_err(|_| error(HistoryError::Invalid))?.0;
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let conversation = conversation(&id)?;
    let rows = s
        .store
        .conversation_timer_inputs(
            &credential,
            &owner,
            &conversation,
            query.after_sequence.unwrap_or(0),
            query.limit.unwrap_or(50),
        )
        .await
        .map_err(error)?;
    Ok(Json(Inputs {
        conversation_id: conversation,
        inputs: rows.into_iter().map(input).collect(),
    }))
}
