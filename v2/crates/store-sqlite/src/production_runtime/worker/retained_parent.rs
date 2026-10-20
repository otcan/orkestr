//! Existing child lineage after an ordinary parent proposal. This never issues
//! parent execution or another delegation; the child's own bounds still apply.
use super::*;
use sqlx::sqlite::SqliteRow;

impl Store {
    pub(super) async fn worker_proposal_parent_in(
        &self,
        conn: &mut SqliteConnection,
        parent: &SqliteRow,
    ) -> Result<()> {
        let c = self.context()?;
        c.validate(conn).await?;
        let p = super::super::admission::envelope(parent)?;
        if parent.get::<&str, _>("state") != "awaiting_acceptance"
            || p.run.role != Role::Deep
            || p.run.lease_deadline_ms <= now(conn).await?
        {
            return Err(RuntimeStoreError::Fenced);
        }
        self.window_effect_in(conn, &p, parent.get("event_id"), false)
            .await?;
        let ready: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings b JOIN production_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.role='deep' AND b.state='busy' AND b.generation=? AND b.provider_kind=? AND b.provider_namespace=? AND b.native_session_id=? AND r.context_id=? AND r.incarnation_id=?")
            .bind(p.run.session_id.to_string()).bind(c.owner.to_string()).bind(p.run.conversation_id.to_string())
            .bind(i64::try_from(p.binding.generation).map_err(db)?).bind(provider_name(c.provider)?)
            .bind(&c.namespace).bind(&p.run.native_session_id).bind(&c.id).bind(&c.incarnation)
            .fetch_one(&mut *conn).await.map_err(db)?;
        let completed: i64 = sqlx::query_scalar("SELECT count(*) FROM production_observations o JOIN events e ON e.id=o.event_id WHERE o.run_id=? AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' AND o.lease_generation=? AND o.dispatch_fence=? AND e.kind='provider_observed' AND e.schema_version=5 AND e.owner_id=? AND e.conversation_id=?")
            .bind(p.run.run_id.to_string()).bind(i64::try_from(p.run.lease_generation).map_err(db)?)
            .bind(i64::try_from(p.run.dispatch_fence).map_err(db)?).bind(c.owner.to_string())
            .bind(p.run.conversation_id.to_string()).fetch_one(&mut *conn).await.map_err(db)?;
        let held: i64 =
            sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds WHERE event_id=?")
                .bind(parent.get::<&str, _>("event_id"))
                .fetch_one(&mut *conn)
                .await
                .map_err(db)?;
        if ready != 1 || completed != 1 || held != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        self.validate_workspace_binding(conn, &p.binding).await?;
        Ok(())
    }
}
