//! Every conversation's agent grants (ORK-794, ORK-804).
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
//! ORK-804: the local folder tool (`v2/tools/local_files.py`) has its own
//! grant, installed beside it as `<conversation>.local-files.grant` the same
//! way, so no operator step is needed (an operator install into a directory
//! the agent could not see left the owner's folder unreachable). A grant alone
//! reaches nothing: the owner still connects a folder in his browser and
//! allows every write. An installed file counts as present only while it holds
//! the grant Core has now; a file left stale by a rotation elsewhere is
//! replaced by a new grant.
//!
//! A grant the owner or an operator revoked stays revoked, and a restricted or
//! archived conversation gets none. A failure is logged and never refuses the
//! creation or the input: the conversation works, only its tools wait.
use crate::whatsapp_chats::{self as chats, StageError};
use crate::AppState;
use orkestr_v2_contracts::{ConversationId, OwnerId};
use orkestr_v2_store_sqlite::{ResourceError, Store};
use std::path::{Path, PathBuf};

const FAILED: StageError = StageError("agent_timer_grant_failed");
const LOCAL_FILES_FAILED: StageError = StageError("local_files_grant_failed");

/// One issue at a time: two concurrent issues for one conversation could
/// leave the older grant's file installed over the newer hash.
static ISSUING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Grant {
    /// No `agent_timers` configured: this server issues no grants.
    Unconfigured,
    /// Issued, and its file is installed and current.
    Present,
    /// Issued now (or again, after its file was lost or went stale) and installed.
    Issued,
    /// Revoked by the owner or an operator; left revoked.
    Revoked,
    /// A restricted or archived conversation.
    Unavailable,
    /// This credential may not manage the grant (a local-files grant needs
    /// the owner's browser, machine or service session); left as it is.
    NotAllowed,
}

/// What to do with a revoked grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Revoked {
    Keep,
    /// Only for the conversation "New WhatsApp chat" is provisioning.
    Reissue,
}

/// The conversation's agent-visible grants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// `<conversation>.grant`: the timer and reply attachment tools.
    Agent,
    /// `<conversation>.local-files.grant`: the local folder tool.
    LocalFiles,
}

impl Kind {
    fn failed(self) -> StageError {
        match self {
            Kind::Agent => FAILED,
            Kind::LocalFiles => LOCAL_FILES_FAILED,
        }
    }
    /// Server state of the grant: (issued, generation).
    async fn state(
        self,
        store: &Store,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<(bool, i64), ResourceError> {
        Ok(match self {
            Kind::Agent => {
                let grant = store
                    .agent_timer_grant(credential, owner, conversation)
                    .await?;
                (grant.issued, grant.generation)
            }
            Kind::LocalFiles => {
                let grant = store
                    .local_file_grant(credential, owner, conversation)
                    .await?;
                (grant.issued, grant.generation)
            }
        })
    }
    async fn current(
        self,
        store: &Store,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        grant: &str,
    ) -> Result<bool, ResourceError> {
        match self {
            Kind::Agent => {
                store
                    .agent_timer_grant_current(credential, owner, conversation, grant)
                    .await
            }
            Kind::LocalFiles => {
                store
                    .local_file_grant_current(credential, owner, conversation, grant)
                    .await
            }
        }
    }
    /// Issue (or rotate) the grant; `None` for a restricted or archived conversation.
    async fn issue(
        self,
        store: &Store,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Option<String>, ResourceError> {
        let issued = match self {
            Kind::Agent => store
                .issue_agent_timer_grant(credential, owner, conversation)
                .await
                .map(|issued| issued.grant),
            Kind::LocalFiles => store
                .issue_local_file_grant(credential, owner, conversation)
                .await
                .map(|issued| issued.grant),
        };
        match issued {
            Ok(grant) => Ok(Some(grant)),
            Err(ResourceError::Conflict(
                "agent_timer_conversation_unavailable" | "local_files_conversation_unavailable",
            )) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// `<grant_dir>/<conversation>.local-files.grant`, beside the agent grant.
pub(crate) fn local_files_path(agent: &Path, conversation: &ConversationId) -> PathBuf {
    agent.with_file_name(format!("{conversation}.local-files.grant"))
}

/// A well-formed installed file that still holds Core's current grant.
async fn installed_current(
    kind: Kind,
    store: &Store,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
    path: &Path,
) -> Result<bool, StageError> {
    if !chats::timer_grant_installed(path) {
        return Ok(false);
    }
    let value = std::fs::read_to_string(path).map_err(|_| kind.failed())?;
    kind.current(store, credential, owner, conversation, value.trim())
        .await
        .map_err(|_| kind.failed())
}

async fn settled(
    kind: Kind,
    store: &Store,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
    path: &Path,
    revoked: Revoked,
) -> Result<Option<Grant>, StageError> {
    let (issued, generation) = match kind.state(store, credential, owner, conversation).await {
        Ok(state) => state,
        Err(ResourceError::Unauthorized) if kind == Kind::LocalFiles => {
            return Ok(Some(Grant::NotAllowed))
        }
        Err(_) => return Err(kind.failed()),
    };
    Ok(
        if issued && installed_current(kind, store, credential, owner, conversation, path).await? {
            Some(Grant::Present)
        } else if !issued && generation > 0 && revoked == Revoked::Keep {
            Some(Grant::Revoked)
        } else {
            None
        },
    )
}

/// Issues the grant of `kind` and installs it at `path` unless an issued
/// grant's current file is already installed there. Idempotent; a retry keeps
/// a present grant.
pub(crate) async fn install_kind(
    kind: Kind,
    store: &Store,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
    path: &Path,
    revoked: Revoked,
) -> Result<Grant, StageError> {
    if let Some(done) = settled(kind, store, credential, owner, conversation, path, revoked).await?
    {
        return Ok(done);
    }
    let _one = ISSUING.lock().await;
    if let Some(done) = settled(kind, store, credential, owner, conversation, path, revoked).await?
    {
        return Ok(done);
    }
    // Never issue (rotate) a grant that cannot be installed.
    chats::timer_grant_dir(path).map_err(|_| kind.failed())?;
    let Some(grant) = kind
        .issue(store, credential, owner, conversation)
        .await
        .map_err(|_| kind.failed())?
    else {
        return Ok(Grant::Unavailable);
    };
    chats::install_timer_grant(path, &grant).map_err(|_| kind.failed())?;
    Ok(Grant::Issued)
}

/// The agent grant (timer and reply attachment tools) at `path`.
pub(crate) async fn install(
    store: &Store,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
    path: &Path,
    revoked: Revoked,
) -> Result<Grant, StageError> {
    install_kind(
        Kind::Agent,
        store,
        credential,
        owner,
        conversation,
        path,
        revoked,
    )
    .await
}

/// Best effort for a created conversation or an admitted input: the agent
/// grant, then the local-files grant beside it. A failure is logged (never
/// the grant) and the agent grant's outcome returned for tests; callers go on.
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
    let local = install_kind(
        Kind::LocalFiles,
        &state.store,
        credential,
        owner,
        conversation,
        &local_files_path(&path, conversation),
        Revoked::Keep,
    )
    .await;
    if let Err(StageError(code)) = &local {
        eprintln!("local-files grant: conversation {conversation} not provisioned: {code}");
    }
    result
}

/// The local-files grant alone, for tests.
#[cfg(test)]
pub(crate) async fn ensure_local_files(
    state: &AppState,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<Grant, StageError> {
    let config = state.whatsapp_chats.clone().ok_or(LOCAL_FILES_FAILED)?;
    let path =
        chats::timer_grant_path(&config, &conversation.to_string()).ok_or(LOCAL_FILES_FAILED)?;
    install_kind(
        Kind::LocalFiles,
        &state.store,
        credential,
        owner,
        conversation,
        &local_files_path(&path, conversation),
        Revoked::Keep,
    )
    .await
}

#[cfg(test)]
#[path = "conversation_grants_tests.rs"]
mod tests;
