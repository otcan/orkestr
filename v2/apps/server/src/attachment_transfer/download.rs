//! Pure HTTP projection, after fresh owner-scoped Store retrieval.
use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode},
};
use orkestr_v2_contracts::{AttachmentReference, AttachmentState};
use sha2::{Digest, Sha256};

pub(super) fn response(
    reference: &AttachmentReference,
    bytes: Vec<u8>,
) -> Result<Response<Body>, ()> {
    if !reference.is_valid()
        || reference.state != AttachmentState::Available
        || reference.byte_length != bytes.len() as u64
        || reference.sha256 != format!("{:x}", Sha256::digest(&bytes))
    {
        return Err(());
    }
    // Fixed ASCII fallback; UTF8 RFC 8187 extended value. Encode every byte
    // outside unreserved characters, including quotes, percent and apostrophe.
    let mut filename = String::new();
    for byte in reference.filename.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            filename.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(filename, "%{byte:02X}").map_err(|_| ())?;
        }
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&reference.media_type).map_err(|_| ())?,
        )
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"attachment\"; filename*=UTF-8''{filename}"),
        )
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(bytes))
        .map_err(|_| ())
}

/// Header naming the stored format of a sealed download.
pub(super) const FORMAT_HEADER: &str = "x-orkestr-attachment-format";
/// Comma-separated fingerprints of the recipients a sealed object was sealed to.
pub(super) const RECIPIENTS_HEADER: &str = "x-orkestr-attachment-recipients";

/// Sealed object: the age ciphertext only, under an opaque filename. The
/// browser decrypts it and verifies the plaintext against the manifest.
pub(super) fn sealed_response(
    reference: &AttachmentReference,
    ciphertext: Vec<u8>,
    recipient_fingerprints: &[String],
) -> Result<Response<Body>, ()> {
    if !reference.is_valid()
        || reference.state != AttachmentState::Available
        || recipient_fingerprints.is_empty()
        || recipient_fingerprints
            .iter()
            .any(|f| f.is_empty() || !f.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':'))
    {
        return Err(());
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/age")
        .header(header::CONTENT_LENGTH, ciphertext.len())
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"attachment-{}.age\"",
                reference.reference_id
            ),
        )
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(FORMAT_HEADER, "age-x25519-v1")
        .header(RECIPIENTS_HEADER, recipient_fingerprints.join(","))
        .body(Body::from(ciphertext))
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    fn reference(bytes: &[u8]) -> AttachmentReference {
        AttachmentReference {
            reference_id: Uuid::new_v4(),
            message_id: None,
            filename: "synthetic-é'\"%.bin".into(),
            media_type: "application/octet-stream".into(),
            byte_length: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            state: AttachmentState::Available,
        }
    }
    #[tokio::test]
    async fn exact_raw_bytes_and_closed_headers() {
        let bytes = b"\0\xff\r\nsynthetic";
        let response = response(&reference(bytes), bytes.to_vec()).unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_LENGTH], bytes.len().to_string());
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            headers[header::CONTENT_DISPOSITION],
            "attachment; filename=\"attachment\"; filename*=UTF-8''synthetic-%C3%A9%27%22%25.bin"
        );
        assert!(!headers.contains_key(header::CONTENT_ENCODING));
        assert!(!headers.contains_key(header::LOCATION));
        let body = axum::body::to_bytes(response.into_body(), bytes.len())
            .await
            .unwrap();
        assert_eq!(body.as_ref(), bytes);
    }
    #[test]
    fn digest_length_removed_and_unsafe_metadata_refuse() {
        let bytes = b"synthetic";
        let original = reference(bytes);
        for case in 0..4 {
            let mut value = original.clone();
            match case {
                0 => value.sha256 = "0".repeat(64),
                1 => value.byte_length += 1,
                2 => value.state = AttachmentState::Removed,
                _ => value.filename = "bad\r\nheader".into(),
            }
            assert!(response(&value, bytes.to_vec()).is_err());
        }
    }
    #[test]
    fn empty_bytes_have_exact_zero_length() {
        assert_eq!(
            response(&reference(b""), vec![]).unwrap().headers()[header::CONTENT_LENGTH],
            "0"
        );
    }
    #[tokio::test]
    async fn sealed_download_is_opaque_ciphertext() {
        let reference = reference(b"synthetic");
        let response = sealed_response(
            &reference,
            b"age-encryption.org/v1\nsynthetic".to_vec(),
            &["SHA256:0123456789abcdef0123456789abcdef".into()],
        )
        .unwrap();
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "application/age");
        assert_eq!(headers[FORMAT_HEADER], "age-x25519-v1");
        assert_eq!(
            headers[RECIPIENTS_HEADER],
            "SHA256:0123456789abcdef0123456789abcdef"
        );
        assert!(!headers[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("synthetic"));
        assert!(sealed_response(&reference, vec![1], &[]).is_err());
        assert!(sealed_response(&reference, vec![1], &["a\r\nb".into()]).is_err());
    }
}
