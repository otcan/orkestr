//! Browser recipients for attachment encryption (V1 protocol).
//!
//! - `GET /api/v2/attachment-keys`: policy, recipients and a plaintext-residue count.
//! - `POST /api/v2/attachment-keys`: register an `age1...` recipient; returns
//!   its possession challenge (age ciphertext for that recipient).
//! - `POST /api/v2/attachment-keys/{id}/verify`: the decrypted challenge
//!   activates the recipient; plaintext objects are then sealed for it.
//! - `POST /api/v2/attachment-keys/{id}/revoke`: excluded from new objects.
//! - `POST /api/v2/attachment-keys/policy`: fail-closed switch (needs an active key).
use super::*;
use crate::archived_history_http::owner_credential;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_store_sqlite::attachment_store::AttachmentError;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/attachment-keys", get(status).post(register))
        .route("/api/v2/attachment-keys/policy", post(policy))
        .route("/api/v2/attachment-keys/{id}/verify", post(verify))
        .route("/api/v2/attachment-keys/{id}/revoke", post(revoke))
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "attachment_key_invalid",
        "Invalid attachment key request",
    )
}
fn failure(error: AttachmentError) -> Error {
    use AttachmentError as E;
    match error {
        E::Invalid => invalid(),
        E::Unauthorized => unauthorized(),
        E::NotFound => Error(
            StatusCode::NOT_FOUND,
            "attachment_key_not_found",
            "Attachment key not found",
        ),
        E::Conflict | E::Removed | E::Inert => Error(
            StatusCode::CONFLICT,
            "attachment_key_challenge_not_pending",
            "This key has no open challenge; register it again",
        ),
        E::EncryptionKeyRequired => Error(
            StatusCode::CONFLICT,
            "attachment_encryption_key_required",
            "Enroll a browser key before requiring attachment encryption",
        ),
        E::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Storage unavailable",
        ),
    }
}
fn key_id(value: &str) -> Result<Uuid, Error> {
    Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil())
        .ok_or_else(invalid)
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let status = state
        .store
        .attachment_encryption_status(&credential, &owner)
        .await
        .map_err(failure)?;
    Ok(Json(status).into_response())
}

async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<AttachmentRecipientRegistration>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(request) = body.map_err(|_| invalid())?;
    let record = state
        .store
        .register_attachment_recipient(&credential, &owner, &request)
        .await
        .map_err(failure)?;
    Ok(Json(record).into_response())
}

async fn verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<AttachmentRecipientProof>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let id = key_id(&id)?;
    let Json(request) = body.map_err(|_| invalid())?;
    let record = state
        .store
        .verify_attachment_recipient(&credential, &owner, id, &request.proof)
        .await
        .map_err(failure)?;
    Ok(Json(record).into_response())
}

async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<AttachmentRecipientRevocation>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let id = key_id(&id)?;
    let Json(request) = body.map_err(|_| invalid())?;
    let record = state
        .store
        .revoke_attachment_recipient(&credential, &owner, id, &request.reason)
        .await
        .map_err(failure)?;
    Ok(Json(record).into_response())
}

async fn policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<AttachmentEncryptionPolicyUpdate>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(request) = body.map_err(|_| invalid())?;
    let status = state
        .store
        .set_attachment_encryption_policy(&credential, &owner, request.required)
        .await
        .map_err(failure)?;
    Ok(Json(status).into_response())
}

/// Operator file in the V2 home: public V1 recipients to import at startup.
pub const V1_IMPORT_FILE: &str = "attachment-recipients-import.json";

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct V1Import {
    owner_id: OwnerId,
    recipients: Vec<orkestr_v2_store_sqlite::attachment_store::keys::ImportedRecipient>,
}

/// Startup: imports `<home>/attachment-recipients-import.json` once (renamed
/// to `.imported` afterwards), then seals any plaintext objects of owners
/// with an active recipient. Errors are reported, never fatal: without a
/// recipient the store keeps its fail-closed policy.
pub async fn startup(store: &orkestr_v2_store_sqlite::Store, home: &std::path::Path) {
    let file = home.join(V1_IMPORT_FILE);
    if let Ok(text) = std::fs::read_to_string(&file) {
        match serde_json::from_str::<V1Import>(&text) {
            Ok(import) => match store
                .import_attachment_recipients(&import.owner_id, &import.recipients)
                .await
            {
                Ok(added) => {
                    eprintln!("attachment encryption: imported {added} V1 recipient(s)");
                    let _ = std::fs::rename(&file, file.with_extension("json.imported"));
                }
                Err(error) => eprintln!("attachment encryption: V1 import refused: {error:?}"),
            },
            Err(_) => eprintln!("attachment encryption: V1 import file is invalid"),
        }
    }
    match store.seal_plaintext_attachments().await {
        Ok(0) => {}
        Ok(sealed) => eprintln!("attachment encryption: sealed {sealed} plaintext object(s)"),
        Err(error) => eprintln!("attachment encryption: sealing sweep failed: {error:?}"),
    }
}
