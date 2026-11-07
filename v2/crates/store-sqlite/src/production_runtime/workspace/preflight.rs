//! One fresh physical check per operation, performed before taking a writer.
use super::*;
use std::{
    ops::Deref,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

// This is an operation deadline, not a refresh/cache interval. An expired
// proof never invokes an action and cannot be used by a later operation.
const HANDOFF: Duration = Duration::from_millis(100);

pub(crate) struct WorkspaceCheck {
    owner: OwnerId,
    conversation: ConversationId,
    project: Option<(String, i64, String)>,
    installation: Option<Arc<Installation>>,
    deadline: Option<Instant>,
    alive: AtomicBool,
    effect: AtomicBool,
    context: Option<(String, String, i64)>,
    retained: Option<super::filesystem::RetainedStamp>,
}

pub struct WorkspacePreflight {
    store: Store,
    proof: Arc<WorkspaceCheck>,
    owns: bool,
}
impl Deref for WorkspacePreflight {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.store
    }
}
impl Drop for WorkspacePreflight {
    fn drop(&mut self) {
        if self.owns {
            self.proof.alive.store(false, Ordering::SeqCst);
        }
    }
}
impl WorkspacePreflight {
    /// Same operation only, after the existing transaction proved and changed
    /// supervisor ownership. Physical evidence and deadline are unchanged;
    /// the returned durable Store itself never retains this scoped proof.
    pub(in crate::production_runtime) fn after_verified_takeover(
        &self,
        store: &Store,
    ) -> Result<Self> {
        self.proof.current()?;
        let context = store.context()?;
        if context.owner != self.proof.owner {
            return Err(RuntimeStoreError::Fenced);
        }
        let proof = Arc::new(WorkspaceCheck {
            owner: self.proof.owner.clone(),
            conversation: self.proof.conversation.clone(),
            project: self.proof.project.clone(),
            installation: self.proof.installation.clone(),
            deadline: self.proof.deadline,
            retained: self.proof.retained,
            alive: AtomicBool::new(true),
            effect: AtomicBool::new(false),
            context: Some((
                context.id.clone(),
                context.incarnation.clone(),
                context.generation,
            )),
        });
        let mut scoped = store.clone();
        scoped.workspace_check = Some(proof.clone());
        Ok(Self {
            store: scoped,
            proof,
            owns: true,
        })
    }
}

impl WorkspaceCheck {
    fn current(&self) -> Result<()> {
        if !self.alive.load(Ordering::SeqCst)
            || self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if let Some(installation) = &self.installation {
            installation.check_retained()?;
            if Some(installation.retained_stamp()?) != self.retained {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        Ok(())
    }
}

impl Store {
    pub(in crate::production_runtime) async fn check_workspace_before_writer(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        selected: Option<Arc<Installation>>,
    ) -> Result<WorkspacePreflight> {
        if let Some(proof) = &self.workspace_check {
            if &proof.owner != owner || &proof.conversation != conversation {
                return Err(RuntimeStoreError::Fenced);
            }
            self.workspace_check_current()?;
            if proof.effect.load(Ordering::SeqCst) {
                return Err(RuntimeStoreError::Fenced);
            }
            return Ok(WorkspacePreflight {
                store: self.clone(),
                proof: proof.clone(),
                owns: false,
            });
        }
        #[cfg(test)]
        let legacy = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success=1",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db)?
            < 40;
        #[cfg(not(test))]
        let legacy = false;
        let row = if legacy {
            None
        } else {
            sqlx::query("SELECT id,generation,identity_json FROM workspace_projects WHERE owner_id=? AND conversation_id=?")
            .bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&self.pool).await.map_err(db)?
        };
        let project = row.map(|row| {
            (
                row.get::<String, _>("id"),
                row.get::<i64, _>("generation"),
                row.get::<String, _>("identity_json"),
            )
        });
        let installation = match selected {
            Some(selected) => Some(selected),
            None => project
                .as_ref()
                .map(|(id, _, _)| {
                    self.workspace_handles
                        .0
                        .lock()
                        .map_err(db)?
                        .get(id)
                        .cloned()
                        .ok_or(RuntimeStoreError::Fenced)
                })
                .transpose()?,
        };
        let before = installation
            .as_ref()
            .map(|installation| installation.retained_stamp())
            .transpose()?;
        if let Some(installation) = &installation {
            let retained = installation.clone();
            // Blocking-pool threads inherit Tokio's Handle. Isolate the Root
            // callback from it so its private RPC runtime is legal even when
            // this fence was entered outside Tokio on a current-thread bridge.
            tokio::task::spawn_blocking(move || {
                std::thread::spawn(move || retained.check())
                    .join()
                    .map_err(|_| RuntimeStoreError::Unavailable)?
            })
            .await
            .map_err(db)??;
        }
        let retained = installation
            .as_ref()
            .map(|installation| installation.retained_stamp())
            .transpose()?;
        if before != retained {
            return Err(RuntimeStoreError::Fenced);
        }
        let proof = Arc::new(WorkspaceCheck {
            owner: owner.clone(),
            conversation: conversation.clone(),
            project,
            deadline: installation
                .as_ref()
                .filter(|i| i.root_attested())
                .map(|_| Instant::now() + HANDOFF),
            installation,
            alive: AtomicBool::new(true),
            effect: AtomicBool::new(false),
            retained,
            context: self
                .authority
                .as_ref()
                .map(|c| (c.id.clone(), c.incarnation.clone(), c.generation)),
        });
        let mut store = self.clone();
        store.workspace_check = Some(proof.clone());
        Ok(WorkspacePreflight {
            store,
            proof,
            owns: true,
        })
    }

    pub(in crate::production_runtime) async fn check_binding_before_writer(
        &self,
        binding: &Binding,
    ) -> Result<WorkspacePreflight> {
        self.check_workspace_before_writer(&binding.owner_id, &binding.conversation_id, None)
            .await
    }

    /// Trusted local composition only. This read-only preflight grants no
    /// dispatch; every later Store fence still validates its original grant.
    /// Call before opening a Root control connection which will await a frame.
    pub async fn preflight_workspace(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<WorkspacePreflight> {
        self.check_workspace_before_writer(owner, conversation, None)
            .await
    }

    pub(in crate::production_runtime) fn check_workspace_installation(
        &self,
        installation: &Arc<Installation>,
    ) -> Result<()> {
        let Some(proof) = &self.workspace_check else {
            if installation.root_attested() {
                return Err(RuntimeStoreError::Unavailable);
            }
            return installation.check();
        };
        if !proof
            .installation
            .as_ref()
            .is_some_and(|expected| Arc::ptr_eq(expected, installation))
        {
            return Err(RuntimeStoreError::Fenced);
        }
        self.workspace_check_current()
    }

    pub(in crate::production_runtime) fn checked_workspace_installation(
        &self,
        project: &str,
    ) -> Result<Arc<Installation>> {
        if let Some(proof) = &self.workspace_check {
            self.workspace_check_current()?;
            if proof
                .project
                .as_ref()
                .is_none_or(|(id, _, _)| id != project)
            {
                return Err(RuntimeStoreError::Fenced);
            }
            // An explicit grant can retain different descriptors from a
            // reopened pool. Use the exact installation freshly verified for
            // this attempt; the writer still checks its full durable identity.
            return proof.installation.clone().ok_or(RuntimeStoreError::Fenced);
        }
        self.workspace_handles
            .0
            .lock()
            .map_err(db)?
            .get(project)
            .cloned()
            .ok_or(RuntimeStoreError::Fenced)
    }

    pub(in crate::production_runtime) fn check_workspace_row(
        &self,
        binding: &Binding,
        project: Option<(&str, i64, &str)>,
    ) -> Result<()> {
        if let Some(proof) = &self.workspace_check {
            if proof.owner != binding.owner_id
                || proof.conversation != binding.conversation_id
                || proof
                    .project
                    .as_ref()
                    .map(|(id, generation, identity)| (id.as_str(), *generation, identity.as_str()))
                    != project
            {
                return Err(RuntimeStoreError::Fenced);
            }
            self.workspace_check_current()?;
        }
        Ok(())
    }

    pub(in crate::production_runtime) fn workspace_check_current(&self) -> Result<()> {
        if let Some(proof) = &self.workspace_check {
            if proof.context
                != self
                    .authority
                    .as_ref()
                    .map(|c| (c.id.clone(), c.incarnation.clone(), c.generation))
            {
                return Err(RuntimeStoreError::Fenced);
            }
            proof.current()?;
        }
        Ok(())
    }

    pub(in crate::production_runtime) fn workspace_effect_once(&self) -> Result<()> {
        self.workspace_check_current()?;
        if self
            .workspace_check
            .as_ref()
            .is_some_and(|proof| proof.effect.swap(true, Ordering::SeqCst))
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}
