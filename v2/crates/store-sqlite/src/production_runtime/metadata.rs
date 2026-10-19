//! Pre-run setup authority is distinct from a consumed inference grant.
use super::*;
use orkestr_v2_contracts::RunId;

/// Issued only for a current, owner-scoped Starting binding. No run identity,
/// cloning, serialization or public constructor. Setup commands never grant inference.
pub struct BoundSessionMetadata {
    pub(super) context: Context,
    pub(super) binding: Binding,
    pub(super) parent_run: Option<RunId>,
    pub(super) resume: Option<super::resume_metadata::ResumeLink>,
}
impl BoundSessionMetadata {
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
    pub fn namespace(&self) -> &str {
        &self.context.namespace
    }
    pub fn incarnation_id(&self) -> &str {
        &self.context.incarnation
    }
    pub fn provider(&self) -> ProviderKind {
        self.context.provider
    }
}
/// Trusted adapter evidence links the original setup scope to its confirmed
/// Ready binding. Consumers must also require a matching consumed dispatch;
/// neither this link nor the metadata grant authorizes inference by itself.
pub struct ReadySessionTransition {
    pub(super) metadata: BoundSessionMetadata,
    pub(super) ready: Binding,
}
impl ReadySessionTransition {
    pub fn metadata(&self) -> &BoundSessionMetadata {
        &self.metadata
    }
    pub fn binding(&self) -> &Binding {
        &self.ready
    }
    /// One-way attachment validation. The caller must additionally run the
    /// execution fence around transfer/enqueue; this performs no provider I/O.
    pub fn attach_execution(
        self,
        dispatch: ConsumedProviderDispatch,
    ) -> Result<ConsumedProviderDispatch> {
        // Admission retains the immutable Ready snapshot; the live row is Busy.
        let expected = self.ready;
        if dispatch.parent_run != self.metadata.parent_run
            || dispatch.provider().binding != expected
            || dispatch.namespace() != self.metadata.namespace()
            || dispatch.incarnation_id() != self.metadata.incarnation_id()
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(dispatch)
    }
}
impl Store {
    pub(super) async fn validate_metadata(
        &self,
        tx: &mut SqliteConnection,
        grant: &BoundSessionMetadata,
    ) -> Result<()> {
        if grant.resume.is_some() {
            return self.validate_resume_metadata(tx, grant).await;
        }
        let c = self.context()?;
        c.validate(tx).await?;
        if c.id != grant.context.id
            || c.incarnation != grant.context.incarnation
            || c.owner != grant.context.owner
            || c.namespace != grant.context.namespace
            || c.provider != grant.context.provider
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let row = sqlx::query("SELECT * FROM session_bindings WHERE id=? AND owner_id=?")
            .bind(grant.binding.session_id.to_string())
            .bind(c.owner.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(RuntimeStoreError::NotFound)?;
        let current = crate::runtime::binding(&row)?;
        if current != grant.binding {
            return Err(RuntimeStoreError::Fenced);
        }
        if current.state != SessionState::Starting
            || current.native_session_id.is_some()
            || current.provider_kind != ProviderKind::Unconfigured
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if current.role == Role::Worker {
            let parent = grant.parent_run.as_ref().ok_or(RuntimeStoreError::Fenced)?;
            let row = self.worker_parent_current_in(tx, parent).await?;
            let parent_session: String = row.get("session_id");
            if current.parent_session_id.as_ref().map(ToString::to_string) != Some(parent_session)
                || current.conversation_id.to_string() != row.get::<String, _>("conversation_id")
            {
                return Err(RuntimeStoreError::Fenced);
            }
        } else if grant.parent_run.is_some() {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
    pub async fn authorize_session_metadata(
        &self,
        binding: &Binding,
    ) -> Result<BoundSessionMetadata> {
        let grant = BoundSessionMetadata {
            context: self.context()?.clone(),
            binding: binding.clone(),
            parent_run: None,
            resume: None,
        };
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.validate_metadata(&mut tx, &grant).await?;
        tx.commit().await.map_err(db)?;
        Ok(grant)
    }
    /// Trusted scheduler only: setup authority remains bound to a live consumed
    /// Deep parent at every setup action and readiness commit.
    pub async fn authorize_worker_metadata(
        &self,
        credential: &str,
        parent: &RunId,
        binding: &Binding,
    ) -> Result<BoundSessionMetadata> {
        self.worker_credential(credential)?;
        if binding.role != Role::Worker {
            return Err(RuntimeStoreError::Fenced);
        }
        let grant = BoundSessionMetadata {
            context: self.context()?.clone(),
            binding: binding.clone(),
            parent_run: Some(parent.clone()),
            resume: None,
        };
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.validate_metadata(&mut tx, &grant).await?;
        tx.commit().await.map_err(db)?;
        Ok(grant)
    }
    /// Only bounded synchronous setup enqueue/flush/spawn actions. No inference,
    /// provider waits, blocking pipes or asynchronous work under this lock.
    pub fn with_metadata_fence<T, E>(
        &self,
        grant: &BoundSessionMetadata,
        action: impl FnOnce() -> std::result::Result<T, E>,
    ) -> Result<std::result::Result<T, E>> {
        let operation = async {
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            self.validate_metadata(&mut tx, grant).await?;
            let result = action();
            tx.commit().await.map_err(db)?;
            Ok(result)
        };
        match tokio::runtime::Handle::try_current() {
            Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(|| h.block_on(operation))
            }
            Ok(_) => Err(RuntimeStoreError::Unavailable),
            Err(_) => tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(db)?
                .block_on(operation),
        }
    }
    /// The trusted protocol adapter must first validate persistent native session
    /// identity, canonical workspace and correlated readiness response. Consumes
    /// setup authority; a Ready transition is never inferred from arithmetic.
    pub async fn confirm_metadata_session(
        &self,
        grant: BoundSessionMetadata,
        evidence: NativeSessionConfirmation,
    ) -> Result<ReadySessionTransition> {
        if grant.resume.is_some() {
            return self.confirm_resumed_metadata(grant, evidence).await;
        }
        if evidence.session_id != grant.binding.session_id
            || evidence.expected_generation != grant.binding.generation
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.validate_metadata(&mut tx, &grant).await?;
        let ready = self
            .confirm_native_session_in(&mut tx, evidence, grant.parent_run.is_some())
            .await?;
        tx.commit().await.map_err(db)?;
        Ok(ReadySessionTransition {
            metadata: grant,
            ready,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production_runtime::tests::{claim, setup};
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn setup_transition_and_consumed_attachment_preserve_identity() {
        let f = setup().await;
        let roles = f
            .handle
            .ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap();
        let grant = f
            .handle
            .authorize_session_metadata(&roles.deep)
            .await
            .unwrap();
        assert_eq!(grant.binding(), &roles.deep);
        assert_eq!(
            f.handle
                .with_metadata_fence(&grant, || Ok::<_, ()>(1))
                .unwrap(),
            Ok(1)
        );
        let link = f
            .handle
            .confirm_metadata_session(
                grant,
                NativeSessionConfirmation {
                    session_id: roles.deep.session_id,
                    expected_generation: roles.deep.generation,
                    native_session_id: "synthetic-transition-native".into(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: "synthetic-readiness".into(),
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            f.handle
                .with_metadata_fence(link.metadata(), || Ok::<_, ()>(())),
            Err(RuntimeStoreError::Fenced)
        ));
        let binding = link.binding().clone();
        let input = claim(&f, &binding).await;
        let admitted = f
            .handle
            .admit_run(
                &input,
                &binding.session_id,
                binding.generation,
                "metadata-admission",
            )
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reserved) = f
            .handle
            .claim_provider_dispatch(&admitted, "metadata-reserve")
            .await
            .unwrap()
        else {
            panic!()
        };
        let ExecutionConsumption::Dispatch(cap) =
            f.handle.consume_execution(&reserved).await.unwrap()
        else {
            panic!()
        };
        let cap = link.attach_execution(*cap).unwrap();
        assert_eq!(
            f.handle
                .with_execution_fence(cap.provider(), || Ok::<_, ()>(2))
                .unwrap(),
            Ok(2)
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn different_session_transition_cannot_attach_consumed_deep_run() {
        let f = setup().await;
        let roles = f
            .handle
            .ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap();
        let grant = f
            .handle
            .authorize_session_metadata(&roles.fast)
            .await
            .unwrap();
        let link = f
            .handle
            .confirm_metadata_session(
                grant,
                NativeSessionConfirmation {
                    session_id: roles.fast.session_id,
                    expected_generation: roles.fast.generation,
                    native_session_id: "synthetic-native-fast".into(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: "synthetic-fast-ready".into(),
                },
            )
            .await
            .unwrap();
        let deep = crate::production_runtime::tests::ready(&f).await;
        let input = claim(&f, &deep).await;
        let admitted = f
            .handle
            .admit_run(
                &input,
                &deep.session_id,
                deep.generation,
                "different-session",
            )
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reserved) = f
            .handle
            .claim_provider_dispatch(&admitted, "different-reserve")
            .await
            .unwrap()
        else {
            panic!()
        };
        let ExecutionConsumption::Dispatch(cap) =
            f.handle.consume_execution(&reserved).await.unwrap()
        else {
            panic!()
        };
        assert!(matches!(
            link.attach_execution(*cap),
            Err(RuntimeStoreError::Fenced)
        ));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn metadata_refuses_forgery_revocation_and_unbound_setup() {
        let f = setup().await;
        let roles = f
            .handle
            .ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap();
        assert!(matches!(
            f.store.authorize_session_metadata(&roles.deep).await,
            Err(RuntimeStoreError::Unavailable)
        ));
        let mut forged = roles.deep.clone();
        forged.generation += 1;
        assert!(matches!(
            f.handle.authorize_session_metadata(&forged).await,
            Err(RuntimeStoreError::Fenced)
        ));
        let grant = f
            .handle
            .authorize_session_metadata(&roles.deep)
            .await
            .unwrap();
        f.store.revoke_session(&f.token).await.unwrap();
        let mut calls = 0;
        assert!(matches!(
            f.handle.with_metadata_fence(&grant, || {
                calls += 1;
                Ok::<_, ()>(())
            }),
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert_eq!(calls, 0);
    }
}
