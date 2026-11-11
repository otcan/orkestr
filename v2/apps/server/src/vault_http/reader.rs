//! The stored-login reader: trusted startup configuration and its read route.
//!
//! The operator writes `<ORKESTR_V2_HOME>/vault-stored-login.json` (or the
//! file named by `ORKESTR_V2_VAULT_STORED_LOGIN_CONFIG`), owned by this
//! service's user or root, mode 0600 or 0400:
//!
//! ```json
//! {"format": "orkestr-v2-vault-stored-login-v1", "owner_id": "<uuid>",
//!  "recipient": "age1...", "reader_token_sha256": "<64 hex>"}
//! ```
//!
//! Only the public recipient and the token's digest are here; the token and
//! the identity stay with the root helper. A missing or rejected file only
//! turns stored-login reads off; the rest of the server starts as usual.
use super::*;
use orkestr_v2_store_sqlite::vault::StoredLoginRequest;
use sha2::{Digest, Sha256};

pub(crate) const STORED_LOGIN_CONFIG_ENV: &str = "ORKESTR_V2_VAULT_STORED_LOGIN_CONFIG";
const FORMAT: &str = "orkestr-v2-vault-stored-login-v1";
pub(crate) const READER_HEADER: &str = "x-orkestr-vault-reader";
const READS_PER_MINUTE: u32 = 60;

pub(crate) struct Reader {
    pub(crate) owner: OwnerId,
    pub(crate) recipient: String,
    token_sha256: [u8; 32],
    window: std::sync::Mutex<(Instant, u32)>,
}
impl Reader {
    fn token_matches(&self, supplied: &str) -> bool {
        let supplied = Sha256::digest(supplied.as_bytes());
        supplied
            .iter()
            .zip(self.token_sha256.iter())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    }
    fn admit(&self) -> bool {
        let Ok(mut window) = self.window.lock() else {
            return false;
        };
        if window.0.elapsed() >= Duration::from_secs(60) {
            *window = (Instant::now(), 0);
        }
        window.1 += 1;
        window.1 <= READS_PER_MINUTE
    }
}

#[derive(Default)]
pub(crate) enum ReaderState {
    #[default]
    Unconfigured,
    /// The file exists but was refused: a fixed reason, never its content.
    Rejected(&'static str),
    Ready(Reader),
}
impl ReaderState {
    pub(crate) fn ready(&self) -> Option<&Reader> {
        match self {
            ReaderState::Ready(reader) => Some(reader),
            _ => None,
        }
    }
    pub(crate) fn label(&self) -> &'static str {
        match self {
            ReaderState::Unconfigured => "unconfigured",
            ReaderState::Rejected(_) => "config_rejected",
            ReaderState::Ready(_) => "ready",
        }
    }
    /// The refusal reason of a rejected file, for one startup log line.
    pub(crate) fn rejection(&self) -> Option<&'static str> {
        match self {
            ReaderState::Rejected(reason) => Some(reason),
            _ => None,
        }
    }

    /// Parses the configuration text (custody is checked by [`Self::load`]).
    pub(crate) fn parse(text: &str) -> Self {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct File {
            format: String,
            owner_id: String,
            recipient: String,
            reader_token_sha256: String,
        }
        let Ok(file) = serde_json::from_str::<File>(text) else {
            return Self::Rejected("invalid_json");
        };
        if file.format != FORMAT {
            return Self::Rejected("unknown_format");
        }
        let Some(owner) = Uuid::parse_str(&file.owner_id)
            .ok()
            .filter(|id| !id.is_nil())
            .map(OwnerId)
        else {
            return Self::Rejected("invalid_owner");
        };
        if orkestr_v2_store_sqlite::attachment_store::seal::parse_recipient(&file.recipient)
            .is_none()
        {
            return Self::Rejected("invalid_recipient");
        }
        let digest = &file.reader_token_sha256;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Self::Rejected("invalid_token_digest");
        }
        let mut token_sha256 = [0u8; 32];
        for (i, byte) in token_sha256.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&digest[2 * i..2 * i + 2], 16).unwrap_or(0);
        }
        Self::Ready(Reader {
            owner,
            recipient: file.recipient,
            token_sha256,
            window: std::sync::Mutex::new((Instant::now(), 0)),
        })
    }

    /// Reads the file when it exists: a regular file (no symlink), one link,
    /// owned by root or this process's user, no group or other access.
    #[cfg(unix)]
    pub(crate) fn load(path: &std::path::Path) -> Self {
        use rustix::fs::{fstat, open, FileType, Mode, OFlags};
        use std::io::Read;
        let file = match open(
            path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => std::fs::File::from(fd),
            Err(rustix::io::Errno::NOENT) => return Self::Unconfigured,
            Err(_) => return Self::Rejected("unreadable"),
        };
        let Ok(meta) = fstat(&file) else {
            return Self::Rejected("unreadable");
        };
        if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
            || meta.st_mode & 0o077 != 0
            || meta.st_nlink != 1
            || meta.st_size > 4096
            || ![0, rustix::process::geteuid().as_raw()].contains(&meta.st_uid)
        {
            return Self::Rejected("custody_rejected");
        }
        let mut text = String::new();
        if file.take(4097).read_to_string(&mut text).is_err() {
            return Self::Rejected("unreadable");
        }
        Self::parse(&text)
    }
    #[cfg(not(unix))]
    pub(crate) fn load(_: &std::path::Path) -> Self {
        Self::Unconfigured
    }
}

impl AppState {
    /// Trusted startup only: the stored-login reader configuration, from the
    /// environment's path or `<home>/vault-stored-login.json`.
    pub fn with_vault_stored_login(mut self, home: &std::path::Path) -> Self {
        let path = std::env::var_os(STORED_LOGIN_CONFIG_ENV)
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join("vault-stored-login.json"));
        self.vault_reader = Arc::new(ReaderState::load(&path));
        self
    }
    /// Why the stored-login configuration file was refused, if it was.
    pub fn vault_stored_login_rejection(&self) -> Option<&'static str> {
        self.vault_reader.rejection()
    }
    #[cfg(test)]
    pub(crate) fn with_vault_reader(mut self, state: ReaderState) -> Self {
        self.vault_reader = Arc::new(state);
        self
    }
}

/// `POST /api/v2/vault/stored-login`: machine request with the reader header.
pub(crate) async fn stored_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<StoredLoginRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let Some(reader) = state.vault_reader.ready() else {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "vault_stored_login_unconfigured",
            "Stored-login reads are not configured",
        ));
    };
    if [header::COOKIE, header::AUTHORIZATION, header::ORIGIN]
        .iter()
        .any(|h| headers.contains_key(h))
    {
        return Err(unauthorized());
    }
    let mut supplied = headers.get_all(READER_HEADER).iter();
    let token = supplied.next().and_then(|v| v.to_str().ok());
    let (Some(token), None) = (token, supplied.next()) else {
        return Err(unauthorized());
    };
    if token.len() != 64 || !reader.token_matches(token) {
        return Err(unauthorized());
    }
    if !reader.admit() {
        return Err(Error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Stored-login read rate limit exceeded",
        ));
    }
    let request = json(body)?;
    let found = state
        .store
        .vault_stored_login(&reader.owner, &reader.recipient, &request)
        .await
        .map_err(failure)?;
    Ok(no_store(found))
}
