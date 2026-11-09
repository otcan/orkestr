//! One authenticated read snapshot for the bounded sidebar status batch.
use super::*;
use orkestr_v2_contracts::{ExecutionStatus, ExecutionWindowQueued};

pub struct ConversationStatusSnapshot {
    pub conversation_id: ConversationId,
    pub execution: Result<Option<ExecutionStatus>>,
    pub queue: Option<Result<WindowQueueSnapshot>>,
}

pub struct WindowQueueSnapshot {
    pub entries: Vec<ExecutionWindowQueued>,
    pub queued_total: u32,
    pub active: u32,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct StatusReadCounts {
    pub execution: std::sync::atomic::AtomicUsize,
    pub global_queue: std::sync::atomic::AtomicUsize,
    pub global_live: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl Store {
    pub(crate) fn status_read_counts(&self) -> std::sync::Arc<StatusReadCounts> {
        use std::{
            collections::HashMap,
            path::PathBuf,
            sync::{Arc, LazyLock, Mutex},
        };
        // Counts are keyed by the real fixture database, shared across pool
        // clones, and absent from release builds and production Store state.
        static COUNTS: LazyLock<Mutex<HashMap<PathBuf, Arc<StatusReadCounts>>>> =
            LazyLock::new(Default::default);
        COUNTS
            .lock()
            .unwrap()
            .entry(self.pool.connect_options().get_filename().to_path_buf())
            .or_default()
            .clone()
    }
}

impl Store {
    /// This is a projection, never execution/control authority. Every selected
    /// conversation is owner-scoped in the same snapshot as the credential.
    /// Queue authentication retains its stricter exclusion of window tokens.
    pub async fn conversation_statuses_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversations: &[ConversationId],
        include_queue: bool,
    ) -> Result<Vec<ConversationStatusSnapshot>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if owner.0.is_nil()
            || conversations.is_empty()
            || conversations.len() > 50
            || conversations.iter().any(|id| id.0.is_nil())
            || conversations
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != conversations.len()
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let current: Option<String> = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if current.as_deref() != Some(owner.to_string().as_str()) {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let queue_auth = if include_queue {
            Some(
                browser_owner(self, &mut tx, credential)
                    .await
                    .and_then(|actual| {
                        if actual == *owner {
                            Ok(())
                        } else {
                            Err(RuntimeStoreError::Unauthorized)
                        }
                    }),
            )
        } else {
            None
        };
        let globals = if queue_auth == Some(Ok(())) {
            Some(self.queue_globals_snapshot(&mut tx, owner).await)
        } else {
            None
        };
        let mut rows = Vec::with_capacity(conversations.len());
        for conversation in conversations {
            let execution = self
                .execution_status_snapshot(&mut tx, owner, conversation, None, None, false)
                .await;
            let queue = if let Some(auth) = queue_auth {
                Some(match auth {
                    Err(error) => Err(error),
                    Ok(()) => {
                        self.conversation_queue_snapshot(
                            &mut tx,
                            owner,
                            conversation,
                            globals.as_ref().expect("authenticated queue snapshot"),
                        )
                        .await
                    }
                })
            } else {
                None
            };
            rows.push(ConversationStatusSnapshot {
                conversation_id: conversation.clone(),
                execution,
                queue,
            });
        }
        tx.commit().await.map_err(db)?;
        Ok(rows)
    }

    async fn queue_globals_snapshot(
        &self,
        tx: &mut SqliteConnection,
        owner: &OwnerId,
    ) -> Result<(u32, u32)> {
        let total = self.queue_entries_snapshot(tx, owner, None).await?.len();
        let active = self.live_windows_snapshot(tx, owner).await?;
        Ok((u32::try_from(total).map_err(db)?, active))
    }

    async fn conversation_queue_snapshot(
        &self,
        tx: &mut SqliteConnection,
        owner: &OwnerId,
        conversation: &ConversationId,
        globals: &Result<(u32, u32)>,
    ) -> Result<WindowQueueSnapshot> {
        crate::runtime::scope(tx, owner, conversation).await?;
        let entries = self
            .queue_entries_snapshot(tx, owner, Some(conversation))
            .await?;
        let (queued_total, active) = (*globals)?;
        Ok(WindowQueueSnapshot {
            entries,
            queued_total,
            active,
        })
    }
}

#[cfg(test)]
mod tests;
