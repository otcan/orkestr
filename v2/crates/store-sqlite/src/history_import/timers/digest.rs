//! Digest of silent and low-signal runs, sent as one message at the timer's
//! configured local times (for example 09:00). Generation is done by the
//! timer supervisor; the delivery adapter picks the text up and acknowledges it.
use super::authority::store_clock;
use super::{calendar, policy::DigestConfig, *};

const LISTED: usize = 15;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimerDigest {
    pub id: Uuid,
    pub namespace: Uuid,
    pub conversation_id: ConversationId,
    pub slot_ms: i64,
    pub text: String,
    pub item_count: i64,
    pub created_ms: i64,
    pub delivered_ms: Option<i64>,
}

fn digest_from(row: &SqliteRow) -> Result<TimerDigest> {
    Ok(TimerDigest {
        id: Uuid::parse_str(row.get("id")).map_err(unavailable)?,
        namespace: Uuid::parse_str(row.get("namespace")).map_err(unavailable)?,
        conversation_id: ConversationId(
            Uuid::parse_str(row.get("conversation_id")).map_err(unavailable)?,
        ),
        slot_ms: row.get("slot_ms"),
        text: row.get("text"),
        item_count: row.get("item_count"),
        created_ms: row.get("created_ms"),
        delivered_ms: row.get("delivered_ms"),
    })
}

fn nothing_new(summary: &str) -> bool {
    matches!(summary, "no news" | "no reply")
}

/// Pure rendering so the text is deterministic and testable.
pub(super) fn render(
    label: &str,
    zone: &str,
    slot_ms: i64,
    items: &[(i64, String, String)],
) -> String {
    let quiet: Vec<_> = items
        .iter()
        .filter(|(_, kind, summary)| kind == "silent" && nothing_new(summary))
        .collect();
    let notable: Vec<_> = items
        .iter()
        .filter(|(_, kind, summary)| !(kind == "silent" && nothing_new(summary)))
        .collect();
    let mut out = format!(
        "Digest: {label} - {} quiet run{} since the last digest.",
        items.len(),
        if items.len() == 1 { "" } else { "s" }
    );
    if !quiet.is_empty() {
        out.push_str(&format!(
            "\nNothing new in {} run{}.",
            quiet.len(),
            if quiet.len() == 1 { "" } else { "s" }
        ));
    }
    for (at, _, summary) in notable.iter().take(LISTED) {
        out.push_str(&format!(
            "\n- {} {summary}",
            calendar::local_label(zone, *at, slot_ms)
        ));
    }
    if notable.len() > LISTED {
        out.push_str(&format!("\n- and {} more", notable.len() - LISTED));
    }
    out
}

/// Create the digest that is due for each timer with a digest schedule. At most
/// one digest per timer and slot (unique); an empty slot is recorded as handled.
pub(crate) async fn generate_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    now_ms: i64,
) -> Result<u32> {
    let timers = sqlx::query("SELECT p.namespace,p.digest_json,p.digest_since_ms,t.conversation_id,COALESCE(g.label,'Timer') AS label FROM timer_policies p JOIN dormant_timers t ON t.owner_id=p.owner_id AND t.namespace=p.namespace LEFT JOIN dormant_timer_targets g ON g.owner_id=p.owner_id AND g.namespace=p.namespace WHERE p.owner_id=? AND p.digest_json IS NOT NULL AND t.state='enabled' AND t.conversation_id IS NOT NULL")
        .bind(owner.to_string()).fetch_all(&mut **tx).await.map_err(unavailable)?;
    let mut created = 0;
    for timer in timers {
        let config: DigestConfig =
            serde_json::from_str(timer.get("digest_json")).map_err(unavailable)?;
        let namespace: String = timer.get("namespace");
        let since: i64 = timer.get::<Option<i64>, _>("digest_since_ms").unwrap_or(0);
        let Some(slot) = calendar::latest_slot(&config.timezone, &config.minutes, now_ms) else {
            continue;
        };
        if slot <= since {
            continue;
        }
        let seen: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM timer_digests WHERE owner_id=? AND namespace=? AND slot_ms=?",
        )
        .bind(owner.to_string())
        .bind(&namespace)
        .bind(slot)
        .fetch_one(&mut **tx)
        .await
        .map_err(unavailable)?;
        if seen != 0 {
            continue;
        }
        let rows = sqlx::query("SELECT claim_id,recorded_ms,kind,summary FROM timer_outcomes WHERE owner_id=? AND namespace=? AND kind IN ('silent','digest') AND digest_id IS NULL ORDER BY recorded_ms,rowid")
            .bind(owner.to_string()).bind(&namespace)
            .fetch_all(&mut **tx).await.map_err(unavailable)?;
        let items: Vec<(i64, String, String)> = rows
            .iter()
            .map(|r| (r.get("recorded_ms"), r.get("kind"), r.get("summary")))
            .collect();
        let id = Uuid::new_v4();
        let text = if items.is_empty() {
            String::new()
        } else {
            render(timer.get("label"), &config.timezone, slot, &items)
        };
        sqlx::query("INSERT INTO timer_digests(id,owner_id,namespace,conversation_id,slot_ms,text,item_count,created_ms,delivered_ms) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(id.to_string()).bind(owner.to_string()).bind(&namespace)
            .bind(timer.get::<String, _>("conversation_id")).bind(slot).bind(&text)
            .bind(items.len() as i64).bind(now_ms)
            .bind(items.is_empty().then_some(now_ms))
            .execute(&mut **tx).await.map_err(unavailable)?;
        for row in &rows {
            sqlx::query("UPDATE timer_outcomes SET digest_id=? WHERE claim_id=?")
                .bind(id.to_string())
                .bind(row.get::<String, _>("claim_id"))
                .execute(&mut **tx)
                .await
                .map_err(unavailable)?;
        }
        created += u32::from(!items.is_empty());
    }
    Ok(created)
}

impl Store {
    /// Digests created and not yet delivered to the chat, oldest first.
    pub async fn pending_timer_digests(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        limit: u16,
    ) -> Result<Vec<TimerDigest>> {
        if !(1..=50).contains(&limit) {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let rows = sqlx::query("SELECT * FROM timer_digests WHERE owner_id=? AND conversation_id=? AND delivered_ms IS NULL ORDER BY slot_ms,rowid LIMIT ?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(i64::from(limit))
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let result = rows.iter().map(digest_from).collect();
        tx.commit().await.map_err(unavailable)?;
        result
    }

    /// Recent digests (delivered or not), newest first, for the timer screen.
    pub async fn recent_timer_digests(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        limit: u16,
    ) -> Result<Vec<TimerDigest>> {
        if !(1..=50).contains(&limit) {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let rows = sqlx::query("SELECT * FROM timer_digests WHERE owner_id=? AND conversation_id=? AND item_count>0 ORDER BY slot_ms DESC,rowid DESC LIMIT ?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(i64::from(limit))
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let result = rows.iter().map(digest_from).collect();
        tx.commit().await.map_err(unavailable)?;
        result
    }

    /// Mark a digest as handed to the chat. Replays keep the first time.
    pub async fn acknowledge_timer_digest(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        id: Uuid,
    ) -> Result<()> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let now_ms = store_clock(&mut tx).await?;
        let changed = sqlx::query("UPDATE timer_digests SET delivered_ms=COALESCE(delivered_ms,?) WHERE owner_id=? AND id=? AND conversation_id=?")
            .bind(now_ms).bind(owner.to_string()).bind(id.to_string()).bind(conversation.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?
            .rows_affected();
        if changed != 1 {
            return Err(HistoryError::NotFound);
        }
        tx.commit().await.map_err(unavailable)
    }
}
