//! Closed operator configuration; never accepted from HTTP.
use orkestr_v2_contracts::{ConversationId, OwnerId};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BetaConfig {
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub manager_socket: PathBuf,
    pub launcher: PathBuf,
    pub launcher_sha256: String,
    pub workspace: PathBuf,
    pub namespace: String,
    pub supervisor_key: String,
}
impl BetaConfig {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let key = |s: &str| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        };
        if self.schema_version != 1
            || self.owner_id.0.is_nil()
            || self.conversation_id.0.is_nil()
            || !self.manager_socket.is_absolute()
            || !self.launcher.is_absolute()
            || !self.workspace.is_absolute()
            || !key(&self.namespace)
            || !key(&self.supervisor_key)
            || self.launcher_sha256.len() != 64
            || !self
                .launcher_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid beta configuration");
        }
        Ok(())
    }
}
