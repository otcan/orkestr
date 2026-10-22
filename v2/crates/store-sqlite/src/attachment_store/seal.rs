//! age (X25519) sealing of attachment objects, wire-compatible with the V1 app.
//!
//! The age plaintext is the V1 payload: `ORKESTR-ATTACHMENT-PAYLOAD/1\n`,
//! the decimal header length and `\n`, a JSON header with the original
//! filename, MIME type, size and SHA-256, then the original bytes. The
//! browser decrypts with its own identity and verifies size and checksum.
//! Private identities never reach this server.
use sha2::{Digest, Sha256};
use std::io::Write;
use std::str::FromStr;

pub const SEALED_FORMAT: &str = "age-x25519-v1";
pub const PAYLOAD_MAGIC: &str = "ORKESTR-ATTACHMENT-PAYLOAD/1";
/// Plaintext of a possession challenge, followed by the random nonce.
pub const PROOF_PREFIX: &str = "orkestr-recipient-proof-v1:";
/// age header stanzas plus 16 bytes per 64 KiB chunk stay far below this.
pub const SEALED_MAX_BYTES: usize = 17 * 1024 * 1024;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
/// `SHA256:` and the first 32 hex digits of the recipient string (V1 format).
pub fn fingerprint(recipient: &str) -> String {
    format!("SHA256:{}", &sha256_hex(recipient.as_bytes())[..32])
}
/// A canonical X25519 `age1...` recipient, or `None`.
pub fn parse_recipient(value: &str) -> Option<age::x25519::Recipient> {
    if value.len() > 500 || !value.starts_with("age1") {
        return None;
    }
    let parsed = age::x25519::Recipient::from_str(value).ok()?;
    // Reject alternative spellings so one key has exactly one fingerprint.
    (parsed.to_string() == value).then_some(parsed)
}

/// The V1 payload framing around `bytes`.
pub fn payload(filename: &str, media_type: &str, bytes: &[u8]) -> Vec<u8> {
    let header = serde_json::json!({
        "version": 1,
        "filename": filename,
        "mimetype": media_type,
        "plaintextSize": bytes.len(),
        "plaintextChecksum": sha256_hex(bytes),
    })
    .to_string();
    let mut out = Vec::with_capacity(bytes.len() + header.len() + 48);
    out.extend_from_slice(format!("{PAYLOAD_MAGIC}\n{}\n", header.len()).as_bytes());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(bytes);
    out
}

/// A recipient is invalid or age encryption failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SealError;

/// age-encrypts `plaintext` to every recipient. Refuses an empty set.
pub fn encrypt(recipients: &[String], plaintext: &[u8]) -> Result<Vec<u8>, SealError> {
    let parsed = recipients
        .iter()
        .map(|r| parse_recipient(r).ok_or(SealError))
        .collect::<Result<Vec<_>, SealError>>()?;
    if parsed.is_empty() {
        return Err(SealError);
    }
    let encryptor =
        age::Encryptor::with_recipients(parsed.iter().map(|r| r as &dyn age::Recipient))
            .map_err(|_| SealError)?;
    let mut out = Vec::with_capacity(plaintext.len() + 1024);
    let mut writer = encryptor.wrap_output(&mut out).map_err(|_| SealError)?;
    writer.write_all(plaintext).map_err(|_| SealError)?;
    writer.finish().map_err(|_| SealError)?;
    Ok(out)
}

/// One sealed object: ciphertext and the recipient snapshot it was sealed to.
pub struct Sealed {
    pub ciphertext: Vec<u8>,
    pub ciphertext_sha256: String,
    pub fingerprints: Vec<String>,
}
/// Seals one attachment for `recipients` (`(fingerprint, age1...)` pairs).
pub fn seal(
    recipients: &[(String, String)],
    filename: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<Sealed, SealError> {
    let keys: Vec<String> = recipients.iter().map(|(_, r)| r.clone()).collect();
    let ciphertext = encrypt(&keys, &payload(filename, media_type, bytes))?;
    if ciphertext.len() > SEALED_MAX_BYTES || !ciphertext.starts_with(b"age-encryption.org/v1\n") {
        return Err(SealError);
    }
    Ok(Sealed {
        ciphertext_sha256: sha256_hex(&ciphertext),
        fingerprints: recipients.iter().map(|(f, _)| f.clone()).collect(),
        ciphertext,
    })
}

#[cfg(test)]
pub(crate) mod testing {
    use std::io::Read;
    /// Decrypts with one identity (tests only; the server holds none).
    pub fn decrypt(identity: &age::x25519::Identity, ciphertext: &[u8]) -> Option<Vec<u8>> {
        let decryptor = age::Decryptor::new(ciphertext).ok()?;
        let mut reader = decryptor
            .decrypt(std::iter::once(identity as &dyn age::Identity))
            .ok()?;
        let mut out = Vec::new();
        reader.read_to_end(&mut out).ok()?;
        Some(out)
    }
    /// Parses the V1 payload framing: (metadata JSON, content).
    pub fn decode_payload(bytes: &[u8]) -> Option<(serde_json::Value, Vec<u8>)> {
        let first = bytes.iter().position(|b| *b == b'\n')?;
        if &bytes[..first] != super::PAYLOAD_MAGIC.as_bytes() {
            return None;
        }
        let second = first + 1 + bytes[first + 1..].iter().position(|b| *b == b'\n')?;
        let length: usize = std::str::from_utf8(&bytes[first + 1..second])
            .ok()?
            .parse()
            .ok()?;
        let start = second + 1;
        let header: serde_json::Value =
            serde_json::from_slice(bytes.get(start..start + length)?).ok()?;
        Some((header, bytes[start + length..].to_vec()))
    }
    pub fn identity() -> (age::x25519::Identity, String) {
        let identity = age::x25519::Identity::generate();
        let recipient = identity.to_public().to_string();
        (identity, recipient)
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    #[test]
    fn sealed_payload_round_trips_for_every_recipient() {
        let (a, ra) = identity();
        let (b, rb) = identity();
        let (other, _) = identity();
        let keys = vec![
            (fingerprint(&ra), ra.clone()),
            (fingerprint(&rb), rb.clone()),
        ];
        let bytes = b"\0synthetic attachment\xff".to_vec();
        let sealed = seal(&keys, "notes.txt", "text/plain", &bytes).unwrap();
        assert_eq!(sealed.ciphertext_sha256, sha256_hex(&sealed.ciphertext));
        assert_eq!(
            sealed.fingerprints,
            vec![fingerprint(&ra), fingerprint(&rb)]
        );
        assert!(!sealed
            .ciphertext
            .windows(b"synthetic".len())
            .any(|w| w == b"synthetic"));
        for identity in [&a, &b] {
            let (meta, content) =
                decode_payload(&decrypt(identity, &sealed.ciphertext).unwrap()).unwrap();
            assert_eq!(content, bytes);
            assert_eq!(meta["version"], 1);
            assert_eq!(meta["filename"], "notes.txt");
            assert_eq!(meta["mimetype"], "text/plain");
            assert_eq!(meta["plaintextSize"], bytes.len());
            assert_eq!(meta["plaintextChecksum"], sha256_hex(&bytes));
        }
        assert!(decrypt(&other, &sealed.ciphertext).is_none());
    }
    #[test]
    fn recipients_are_canonical_x25519_only() {
        let (_, recipient) = identity();
        assert!(parse_recipient(&recipient).is_some());
        assert!(parse_recipient(&recipient.to_uppercase()).is_none());
        assert!(parse_recipient("age1invalid").is_none());
        assert!(parse_recipient("AGE-SECRET-KEY-1QQQQ").is_none());
        assert!(seal(&[], "a", "text/plain", b"x").is_err());
        assert_eq!(fingerprint(&recipient).len(), 39);
    }
    /// Produced by the V1 browser library (age-encryption 0.3.1) for the
    /// synthetic identity below: V1 ciphertext stays readable by this code.
    #[test]
    fn decrypts_reference_ciphertext() {
        let identity: age::x25519::Identity = super::super::seal_fixture::IDENTITY.parse().unwrap();
        let plain = decrypt(&identity, super::super::seal_fixture::CIPHERTEXT).unwrap();
        assert_eq!(plain, super::super::seal_fixture::PLAINTEXT);
    }
}
