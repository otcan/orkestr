//! What happened to each timer run's result: delivered, silent, or held for the
//! digest. The delivery adapter reports every final answer here before sending
//! anything, so "silent unless changed" is decided once, in one place.
use super::authority::store_clock;
use super::{policy::SilentMode, *};
use orkestr_v2_contracts::{classify_timer_result, TimerResult};

const EXCERPT: usize = 280;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeKind {
    Delivered,
    Silent,
    /// Low-signal result held back for the digest.
    Digest,
}
impl OutcomeKind {
    pub fn text(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Silent => "silent",
            Self::Digest => "digest",
        }
    }
    fn parse(value: &str) -> Result<Self> {
        match value {
            "delivered" => Ok(Self::Delivered),
            "silent" => Ok(Self::Silent),
            "digest" => Ok(Self::Digest),
            _ => Err(HistoryError::Unavailable),
        }
    }
    /// Whether the answer should be sent to the chat.
    pub fn deliver(self) -> bool {
        self == Self::Delivered
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedOutcome {
    pub kind: OutcomeKind,
    pub summary: String,
    pub replay: bool,
}

/// Latest result and silent-run count of one timer.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct RunStats {
    pub last_kind: Option<OutcomeKind>,
    pub last_summary: Option<String>,
    pub last_at_ms: Option<i64>,
    /// Silent or digest-held runs since the last delivered result.
    pub silent_runs: i64,
    pub total_runs: i64,
}

fn excerpt(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > EXCERPT {
        line.chars().take(EXCERPT).collect::<String>() + "…"
    } else {
        line
    }
}

pub(super) async fn stats_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
) -> Result<RunStats> {
    let last = sqlx::query("SELECT kind,summary,recorded_ms FROM timer_outcomes WHERE owner_id=? AND namespace=? ORDER BY recorded_ms DESC,rowid DESC LIMIT 1")
        .bind(owner.to_string()).bind(namespace.to_string())
        .fetch_optional(&mut **tx).await.map_err(unavailable)?;
    let counts = sqlx::query("SELECT count(*) AS total, COALESCE(sum(kind!='delivered' AND recorded_ms>COALESCE((SELECT max(d.recorded_ms) FROM timer_outcomes d WHERE d.owner_id=o.owner_id AND d.namespace=o.namespace AND d.kind='delivered'),-1)),0) AS quiet FROM timer_outcomes o WHERE owner_id=? AND namespace=?")
        .bind(owner.to_string()).bind(namespace.to_string())
        .fetch_one(&mut **tx).await.map_err(unavailable)?;
    let mut stats = RunStats {
        silent_runs: counts.get("quiet"),
        total_runs: counts.get("total"),
        ..RunStats::default()
    };
    if let Some(row) = last {
        stats.last_kind = Some(OutcomeKind::parse(row.get("kind"))?);
        stats.last_summary = Some(row.get("summary"));
        stats.last_at_ms = Some(row.get("recorded_ms"));
    }
    Ok(stats)
}

impl Store {
    /// Classify and record one run's final answer. Idempotent per claim: a retry
    /// returns the first decision, so an adapter restart never sends twice.
    pub async fn record_timer_outcome(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        claim_id: Uuid,
        text: &str,
    ) -> Result<RecordedOutcome> {
        if claim_id.is_nil() || text.len() > 1_000_000 {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let claim = sqlx::query("SELECT namespace FROM dormant_timer_claims WHERE owner_id=? AND claim_id=? AND conversation_id=?")
            .bind(owner.to_string()).bind(claim_id.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(unavailable)?
            .ok_or(HistoryError::NotFound)?;
        let namespace = Uuid::parse_str(claim.get("namespace")).map_err(unavailable)?;
        if let Some(old) = sqlx::query("SELECT kind,summary FROM timer_outcomes WHERE claim_id=?")
            .bind(claim_id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?
        {
            let result = RecordedOutcome {
                kind: OutcomeKind::parse(old.get("kind"))?,
                summary: old.get("summary"),
                replay: true,
            };
            tx.commit().await.map_err(unavailable)?;
            return Ok(result);
        }
        let policy = policy::read_in(&mut tx, owner, namespace).await?;
        let silent_on = policy.silent_mode == SilentMode::UnlessChanged;
        let (kind, summary) = match classify_timer_result(text, silent_on) {
            TimerResult::Deliver => (OutcomeKind::Delivered, excerpt(text)),
            TimerResult::Silent { summary } => (OutcomeKind::Silent, summary),
            // Without a digest there is nowhere to collect it: send it.
            TimerResult::LowSignal { summary } if policy.digest.is_some() => {
                (OutcomeKind::Digest, summary)
            }
            TimerResult::LowSignal { .. } => (OutcomeKind::Delivered, excerpt(text)),
        };
        let now_ms = store_clock(&mut tx).await?;
        sqlx::query("INSERT INTO timer_outcomes(claim_id,owner_id,namespace,kind,summary,recorded_ms) VALUES(?,?,?,?,?,?)")
            .bind(claim_id.to_string()).bind(owner.to_string()).bind(namespace.to_string())
            .bind(kind.text()).bind(&summary).bind(now_ms)
            .execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(RecordedOutcome {
            kind,
            summary,
            replay: false,
        })
    }
}
