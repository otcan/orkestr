use super::*;
/// Current-auth, single-cut owner metadata. No prompt, credential or native binding.
#[derive(Clone, Debug)]
pub struct TimerDetail {
    pub receipt: TimerReceipt,
    pub schedule: TimerSchedule,
    pub conversation_id: Option<ConversationId>,
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
        let conversation: Option<String> = row.get("conversation_id");
        let detail = TimerDetail {
            receipt: receipt(&row)?,
            schedule: schedule::decode(row.get("schedule_json"))?,
            conversation_id: conversation
                .map(|s| Uuid::parse_str(&s).map(ConversationId))
                .transpose()
                .map_err(unavailable)?,
        };
        tx.commit().await.map_err(unavailable)?;
        Ok(detail)
    }
}
