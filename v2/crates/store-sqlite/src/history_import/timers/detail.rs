use super::*;
/// Current-auth, single-cut owner metadata. No prompt, credential or native binding.
#[derive(Clone, Debug)]
pub struct TimerDetail {
    pub receipt: TimerReceipt,
    /// Persisted explicit owner grant for this current enabled generation; not scheduler liveness.
    pub durable_authority: bool,
    pub schedule: TimerSchedule,
    pub conversation_id: Option<ConversationId>,
}
pub(super) async fn detail_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    row: &SqliteRow,
) -> Result<TimerDetail> {
    let namespace: String = row.get("namespace");
    let conversation: Option<String> = row.get("conversation_id");
    let durable_authority: i64 = sqlx::query_scalar("SELECT count(*) FROM durable_timer_authorities a JOIN dormant_timers t ON t.owner_id=a.owner_id AND t.namespace=a.namespace AND t.generation=a.generation WHERE a.owner_id=? AND a.namespace=? AND t.state='enabled' AND a.stop_sequence=(SELECT COALESCE(max(e.sequence),0) FROM production_stop_boundaries b JOIN events e ON e.id=b.event_id WHERE b.owner_id=a.owner_id AND b.conversation_id=a.conversation_id)")
        .bind(owner.to_string()).bind(namespace).fetch_one(&mut **tx).await.map_err(unavailable)?;
    Ok(TimerDetail {
        durable_authority: durable_authority == 1,
        receipt: receipt(row)?,
        schedule: schedule::decode(row.get("schedule_json"))?,
        conversation_id: conversation
            .map(|s| Uuid::parse_str(&s).map(ConversationId))
            .transpose()
            .map_err(unavailable)?,
    })
}
impl Store {
    pub async fn dormant_timer_detail(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
    ) -> Result<TimerDetail> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        let row = row(&mut tx, owner, namespace).await?;
        let detail = detail_in(&mut tx, owner, &row).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(detail)
    }
}
