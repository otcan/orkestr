//! Every conversation's agent grant (ORK-794).
//!
//! The reply attachment tool (`v2/tools/reply_attach.py`) and the agent timer
//! tool authenticate with the conversation's agent grant, installed as
//! `<grant_dir>/<conversation>.grant` (0600, the service user's; the broker
//! projects the directory read-only to the agent). Only "New WhatsApp chat"
//! issued one, so a conversation created in the web app could not hand the
//! owner a file. With `agent_timers` configured the server now makes sure of
//! the grant when a conversation or a project is created, and after each input
//! it admits, so an existing conversation without one gets it with its next
//! message and a lost grant file is replaced.
//!
//! A grant the owner or an operator revoked stays revoked, and a restricted or
//! archived conversation gets none. A failure is logged and never refuses the
//! creation or the input: the conversation works, only its tools wait.
use crate::whatsapp_chats::{self as chats, StageError};
use crate::AppState;
use orkestr_v2_contracts::{ConversationId, OwnerId};
use orkestr_v2_store_sqlite::{ResourceError, Store};
use std::path::Path;

const FAILED: StageError = StageError("agent_timer_grant_failed");

/// One issue at a time: two concurrent issues for one conversation could
/// leave the older grant's file installed over the newer hash.
static ISSUING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Grant {
    /// No `agent_timers` configured: this server issues no grants.
    Unconfigured,
    /// Issued, and its file is installed.
    Present,
    /// Issued now (or again, after its file was lost) and installed.
    Issued,
    /// Revoked by the owner or an operator; left revoked.
    Revoked,
    /// A restricted or archived conversation.
    Unavailable,
}

/// What to do with a revoked grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Revoked {
    Keep,
    /// Only for the conversation "New WhatsApp chat" is provisioning.
    Reissue,
}

async fn settled(
    store: &Store,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
    path: &Path,
    revoked: Revoked,
) -> Result<Option<Grant>, StageError> {
    let grant = store
        .agent_timer_grant(credential, owner, conversation)
        .await
        .map_err(|_| FAILED)?;
    Ok(if grant.issued && chats::timer_grant_installed(path) {
        Some(Grant::Present)
    } else if !grant.issued && grant.generation > 0 && revoked == Revoked::Keep {
        Some(Grant::Revoked)
    } else {
        None
    })
}

/// Issues the grant and installs it at `path` unless an issued grant's file
/// is already installed there. Idempotent; a retry keeps a present grant.
pub(crate) async fn install(
    store: &Store,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
    path: &Path,
    revoked: Revoked,
) -> Result<Grant, StageError> {
    if let Some(done) = settled(store, credential, owner, conversation, path, revoked).await? {
        return Ok(done);
    }
    let _one = ISSUING.lock().await;
    if let Some(done) = settled(store, credential, owner, conversation, path, revoked).await? {
        return Ok(done);
    }
    // Never issue (rotate) a grant that cannot be installed.
    chats::timer_grant_dir(path)?;
    let issued = match store
        .issue_agent_timer_grant(credential, owner, conversation)
        .await
    {
        Ok(issued) => issued,
        Err(ResourceError::Conflict("agent_timer_conversation_unavailable")) => {
            return Ok(Grant::Unavailable)
        }
        Err(_) => return Err(FAILED),
    };
    chats::install_timer_grant(path, &issued.grant)?;
    Ok(Grant::Issued)
}

/// Best effort for a created conversation or an admitted input. A failure is
/// logged (never the grant) and returned for tests; callers go on.
pub(crate) async fn ensure(
    state: &AppState,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<Grant, StageError> {
    let Some(config) = state.whatsapp_chats.clone() else {
        return Ok(Grant::Unconfigured);
    };
    let Some(path) = chats::timer_grant_path(&config, &conversation.to_string()) else {
        return Ok(Grant::Unconfigured);
    };
    let result = install(
        &state.store,
        credential,
        owner,
        conversation,
        &path,
        Revoked::Keep,
    )
    .await;
    if let Err(StageError(code)) = &result {
        eprintln!("agent grant: conversation {conversation} not provisioned: {code}");
    }
    result
}

#[cfg(test)]
#[path = "conversation_grants_tests.rs"]
mod tests;
