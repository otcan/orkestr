//! Actual task/run evidence, including only the accepted canonical result.
use super::*;
use orkestr_v2_contracts::RunId;
impl Store {
    pub(super) async fn native_worker_task(
        &self,
        tx: &mut SqliteConnection,
        parent: &ManagedOperationParent,
        task: &TaskId,
    ) -> Result<NativeWorkerObservation> {
        let c = self.context()?;
        let row = sqlx::query("SELECT t.*,p.task_id AS payload_present,d.admitted_run_id,r.state AS run_state,r.provider_kind FROM worker_tasks t LEFT JOIN worker_task_payloads p ON p.task_id=t.id LEFT JOIN worker_provider_delegations d ON d.id=t.delegation_id LEFT JOIN production_runs r ON r.id=d.admitted_run_id AND r.owner_id=t.owner_id AND r.conversation_id=t.conversation_id WHERE t.id=? AND t.owner_id=? AND t.conversation_id=? AND t.parent_run_id=? AND t.context_id=? AND t.incarnation_id=? AND t.issuer_token_hash=? AND t.source_message_id=? AND t.source_event_id=?")
            .bind(task.to_string()).bind(c.owner.to_string()).bind(parent.parent.run.conversation_id.to_string())
            .bind(parent.parent.run.run_id.to_string()).bind(&c.id).bind(&c.incarnation).bind(&c.token_hash)
            .bind(&parent.source_message_id).bind(&parent.source_event_id)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        let run: Option<String> = row.get("admitted_run_id");
        let state: Option<&str> = row.get("run_state");
        let current_revision: i64 =
            sqlx::query_scalar("SELECT revision FROM production_control_revisions WHERE run_id=?")
                .bind(parent.parent.run.run_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        let authority_current = current_revision == row.get::<i64, _>("parent_control_revision");
        let child_current = match run
            .as_deref()
            .filter(|_| matches!(state, Some("starting" | "running")))
        {
            Some(id) => current_authority(
                self.task_run_current_in(&mut *tx, &RunId(id.parse().map_err(db)?))
                    .await,
            )?,
            None => true,
        };
        let live = if matches!(state, Some("starting" | "running")) {
            child_current
        } else {
            authority_current
        };
        let failed: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM worker_task_failures WHERE task_id=?)")
                .bind(task.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        let phase = match state {
            Some("succeeded") => "completed",
            Some("failed") => "failed",
            Some("cancelled") => "cancelled",
            Some("cancel_requested") => "cancel_requested",
            Some("awaiting_acceptance") => "awaiting_acceptance",
            Some("blocked") => "held",
            _ if !live => "held",
            Some("running") => "running",
            Some("starting") => "preparing",
            None if failed => "failed",
            None if row.get::<Option<String>, _>("payload_present").is_none() => "held",
            None => match row.get::<&str, _>("state") {
                "queued" => "queued",
                "claimed" | "delegated" => "claimed",
                "held" => "held",
                _ => return Err(RuntimeStoreError::Unavailable),
            },
            _ => return Err(RuntimeStoreError::Unavailable),
        };
        let mut result = json!({"kind":"native_worker_task","task_id":task.to_string(),"parent_run_id":parent.parent.run.run_id.to_string(),
            "phase":phase,"run_id":run,"provider":row.get::<Option<String>,_>("provider_kind"),"result":null});
        if phase == "completed" {
            let accepted = sqlx::query("SELECT a.event_id AS acceptance_event_id,a.completion_event_id,p.id AS payload_id,p.text FROM production_acceptances a JOIN production_observations o ON o.event_id=a.completion_event_id AND o.run_id=a.run_id AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' LEFT JOIN production_payloads p ON p.id=(SELECT payload.id FROM production_payloads payload JOIN production_observations progress ON progress.event_id=payload.event_id AND progress.run_id=payload.run_id AND progress.kind='progress' WHERE payload.run_id=a.run_id AND payload.owner_id=a.owner_id AND payload.conversation_id=a.conversation_id AND progress.run_sequence<o.run_sequence ORDER BY progress.run_sequence DESC LIMIT 1) WHERE a.run_id=? AND a.owner_id=? AND a.conversation_id=?")
                .bind(run.as_deref().ok_or(RuntimeStoreError::Unavailable)?).bind(c.owner.to_string())
                .bind(parent.parent.run.conversation_id.to_string()).fetch_optional(&mut *tx).await.map_err(db)?
                .ok_or(RuntimeStoreError::Unavailable)?;
            let text: Option<String> = accepted.get("text");
            let payload: Option<String> = accepted.get("payload_id");
            let removed = payload.is_some() && text.is_none();
            let preview = text
                .as_deref()
                .map(|s| s.chars().take(512).collect::<String>());
            result["result"] = json!({"acceptance_event_id":accepted.get::<String,_>("acceptance_event_id"),
                "completion_event_id":accepted.get::<String,_>("completion_event_id"),"payload_id":payload,
                "text":preview,"truncated":text.as_ref().is_some_and(|s| s.chars().count()>512),"payload_removed":removed});
        }
        Ok(NativeWorkerObservation {
            result,
            terminal: matches!(phase, "completed" | "failed" | "cancelled" | "held"),
        })
    }
}
