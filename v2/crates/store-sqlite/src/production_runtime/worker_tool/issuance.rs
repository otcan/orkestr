use super::*;
use crate::runtime::ledger::{hash, secret};

impl Store {
    /// Explicit trusted server decision. Borrowing a provider capability supplies
    /// parent lineage only; only this separate persisted delegation grants the tool.
    pub async fn delegate_offline_python(
        &self,
        credential: &str,
        parent: &ConsumedProviderDispatch,
        request_key: &str,
        source: &str,
        lifetime_ms: u32,
    ) -> Result<OfflinePythonAdmission> {
        self.delegate_offline_python_in_context(
            credential,
            parent.provider(),
            (parent.namespace(), parent.incarnation_id()),
            request_key,
            source,
            lifetime_ms,
        )
        .await
    }

    pub(super) async fn delegate_offline_python_in_context(
        &self,
        credential: &str,
        parent: &ProviderAdmission,
        identity: (&str, &str),
        request_key: &str,
        source: &str,
        lifetime_ms: u32,
    ) -> Result<OfflinePythonAdmission> {
        if !valid(request_key)
            || source.is_empty()
            || source.len() > 65536
            || source.contains('\0')
            || !(1..=30000).contains(&lifetime_ms)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        execution(self, &mut tx, credential, parent).await?;
        let context = self.context()?;
        if identity.0 != context.namespace || identity.1 != context.incarnation {
            return Err(RuntimeStoreError::Fenced);
        }
        let source_digest = crate::digest(source);
        if let Some(row) = sqlx::query("SELECT * FROM worker_tool_delegations WHERE owner_id=? AND parent_run_id=? AND request_key=?")
            .bind(context.owner.to_string()).bind(parent.run.run_id.to_string()).bind(request_key)
            .fetch_optional(&mut *tx).await.map_err(db)? {
            load(self, &mut tx, Uuid::parse_str(row.get("id")).map_err(db)?, parent, &context.id, &context.incarnation).await?;
            if row.get::<&str, _>("source_digest") != source_digest || row.get::<i64, _>("requested_lifetime_ms") != i64::from(lifetime_ms) {
                return Err(RuntimeStoreError::Conflict);
            }
            let result = receipt(&row)?;
            tx.commit().await.map_err(db)?;
            return Ok(OfflinePythonAdmission::Existing(result));
        }
        let id = Uuid::new_v4();
        let locator = secret();
        let expires = now(&mut tx)
            .await?
            .checked_add(i64::from(lifetime_ms))
            .ok_or(RuntimeStoreError::Unavailable)?
            .min(parent.run.lease_deadline_ms);
        let p = parent;
        sqlx::query("INSERT INTO worker_tool_delegations(id,owner_id,conversation_id,parent_run_id,parent_session_id,context_id,incarnation_id,parent_binding_generation,parent_lease_generation,parent_dispatch_fence,parent_deadline_ms,operation,request_key,source_digest,source_text,requested_lifetime_ms,expires_at_ms,state,revision,grant_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,'python_offline_v1',?,?,?,?,?,'delegated',1,?)")
            .bind(id.to_string()).bind(context.owner.to_string()).bind(p.run.conversation_id.to_string())
            .bind(p.run.run_id.to_string()).bind(p.run.session_id.to_string()).bind(&context.id).bind(&context.incarnation)
            .bind(i64::try_from(p.binding.generation).map_err(db)?).bind(i64::try_from(p.run.lease_generation).map_err(db)?)
            .bind(i64::try_from(p.run.dispatch_fence).map_err(db)?).bind(p.run.lease_deadline_ms)
            .bind(request_key).bind(&source_digest).bind(source).bind(i64::from(lifetime_ms)).bind(expires)
            .bind(hash("offline-python-delegation-v1", &[&locator])).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(OfflinePythonAdmission::Fresh(OfflinePythonDelegation {
            id,
            parent: Box::new(p.clone()),
            context_id: context.id.clone(),
            incarnation: context.incarnation.clone(),
            locator,
            source_digest,
            expires_at_ms: expires,
        }))
    }

    pub async fn consume_offline_python(
        &self,
        credential: &str,
        grant: OfflinePythonDelegation,
    ) -> Result<OfflinePythonConsumption> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        execution(self, &mut tx, credential, &grant.parent).await?;
        let row = load(
            self,
            &mut tx,
            grant.id,
            &grant.parent,
            &grant.context_id,
            &grant.incarnation,
        )
        .await?;
        if row.get::<&str, _>("source_digest") != grant.source_digest
            || row.get::<i64, _>("expires_at_ms") != grant.expires_at_ms
        {
            return Err(RuntimeStoreError::Conflict);
        }
        if grant.expires_at_ms <= now(&mut tx).await? {
            return Err(RuntimeStoreError::Expired);
        }
        if row.get::<&str, _>("state") != "delegated" {
            return Ok(OfflinePythonConsumption::ReconciliationRequired);
        }
        if row.get::<Option<String>, _>("grant_hash")
            != Some(hash("offline-python-delegation-v1", &[&grant.locator]))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let source: String = row.get("source_text");
        if crate::digest(&source) != grant.source_digest {
            return Err(RuntimeStoreError::Unavailable);
        }
        let updated = sqlx::query("UPDATE worker_tool_delegations SET state='delivery_unknown',grant_hash=NULL,revision=revision+1 WHERE id=? AND state='delegated' RETURNING *")
            .bind(grant.id.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let receipt = receipt(&updated)?;
        tx.commit().await.map_err(db)?;
        Ok(OfflinePythonConsumption::Launch(ConsumedOfflinePython {
            parent: grant.parent,
            context_id: grant.context_id,
            incarnation: grant.incarnation,
            source,
            expires_at_ms: grant.expires_at_ms,
            receipt: Box::new(receipt),
            spawn_spent: AtomicBool::new(false),
        }))
    }
}
