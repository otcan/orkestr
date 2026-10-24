//! Application storage port. Adapters own transactions; no provider is awaited on admission.
pub mod runtime;
use orkestr_v2_contracts::*;
use std::future::Future;
#[derive(Debug)]
pub enum StoreError {
    Invalid,
    Conflict,
    ProviderGenerationMismatch,
    NotFound,
    AlreadySetup,
    Unavailable,
}
pub type Result<T> = std::result::Result<T, StoreError>;
#[derive(Debug)]
pub struct Admission {
    pub receipt: Receipt,
    pub duplicate: bool,
}
#[derive(Debug)]
pub struct ProjectAdmission {
    pub project: Project,
    pub duplicate: bool,
}
pub trait IntakeStore: Send + Sync {
    fn admit(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &MessageInput,
    ) -> impl Future<Output = Result<Admission>> + Send;
    fn create_project(
        &self,
        owner: &OwnerId,
        input: &ProjectInput,
    ) -> impl Future<Output = Result<ProjectAdmission>> + Send;
    fn projects(
        &self,
        owner: &OwnerId,
        after: i64,
        limit: u32,
    ) -> impl Future<Output = Result<ProjectPage>> + Send;
    fn snapshot(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        after: i64,
        limit: u32,
    ) -> impl Future<Output = Result<ConversationSnapshot>> + Send;
    /// Read bounded ordered committed metadata. Cursor must be 0..=current high-water mark.
    fn events(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        after: i64,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<ConversationEvent>>> + Send;
}
