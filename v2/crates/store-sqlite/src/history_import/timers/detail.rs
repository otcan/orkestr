use super::*;
/// Current-auth, single-cut owner metadata. No credential or native binding.
#[derive(Clone, Debug)]
pub struct TimerDetail {
    pub receipt: TimerReceipt,
    /// Persisted explicit owner grant for this current enabled generation; not scheduler liveness.
    pub durable_authority: bool,
    pub schedule: TimerSchedule,
    pub conversation_id: Option<ConversationId>,
    /// What the timer's next firing receives under its latest durable grant,
    /// for the owner's single-timer read only (never listings). `None` when
    /// the timer never held a durable grant here, such as an import not yet
    /// enabled in V2.
    pub instruction: Option<String>,
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
        instruction: None,
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
        let mut detail = detail_in(&mut tx, owner, &row).await?;
        let latest: Option<(String, i64)> = sqlx::query_as(
            "SELECT instruction,generation FROM durable_timer_authorities WHERE owner_id=? AND namespace=? ORDER BY generation DESC LIMIT 1",
        )
        .bind(owner.to_string())
        .bind(namespace.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if let Some((granted, generation)) = latest {
            detail.instruction = Some(
                super::instruction_update::effective_in(
                    &mut tx, owner, namespace, generation, granted,
                )
                .await?,
            );
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(detail)
    }
}
