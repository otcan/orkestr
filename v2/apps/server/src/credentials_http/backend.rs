//! Which store the credentials page manages, chosen at startup.
//!
//! Without a configuration file the page manages the built-in vault
//! (`vault_http`), as before. An operator selects OpenBao with
//! `<ORKESTR_V2_HOME>/credentials-backend.json`, or the file named by
//! `ORKESTR_V2_CREDENTIALS_CONFIG` (for example a systemd credential:
//! `%d/credentials-backend.json`). It holds the AppRole secret, so its custody
//! is checked like the stored-login file: a regular file owned by root or
//! this service's user, mode 0600 or 0400.
//!
//! ```json
//! {"format": "orkestr-v2-credentials-backend-v1", "backend": "openbao",
//!  "address": "http://127.0.0.1:8200", "mount": "orkestr", "prefix": "creds",
//!  "role_id": "<uuid>", "secret_id": "<uuid>",
//!  "catalog": "/var/lib/example/credentials-catalog.json",
//!  "usage_summary": "/var/lib/example/credentials-usage.json",
//!  "reveal_url": "https://bao.example.invalid/ui/vault/secrets/orkestr/show/creds/{id}"}
//! ```
//!
//! `catalog`, `usage_summary` and `reveal_url` are optional. A refused file
//! does not fall back to the built-in vault: the page reports the refusal, so
//! the owner never edits a store he did not mean to.
use super::loopback;
use super::openbao::OpenBao;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) const CONFIG_ENV: &str = "ORKESTR_V2_CREDENTIALS_CONFIG";
const FORMAT: &str = "orkestr-v2-credentials-backend-v1";
const MAX_CONFIG: usize = 8 * 1024;

#[derive(Clone)]
pub(crate) enum Backend {
    /// The built-in vault; the default.
    V2Vault { usage: Option<PathBuf> },
    OpenBao {
        client: Arc<OpenBao>,
        usage: Option<PathBuf>,
    },
    /// A configuration file exists but was refused: a fixed reason only.
    Refused(&'static str),
}
impl Default for Backend {
    fn default() -> Self {
        Backend::V2Vault { usage: None }
    }
}

impl Backend {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Backend::V2Vault { .. } => "v2_vault",
            Backend::OpenBao { .. } => "openbao",
            Backend::Refused(_) => "unconfigured",
        }
    }
    pub(crate) fn usage_path(&self) -> Option<&Path> {
        match self {
            Backend::V2Vault { usage } | Backend::OpenBao { usage, .. } => usage.as_deref(),
            Backend::Refused(_) => None,
        }
    }
    pub(crate) fn rejection(&self) -> Option<&'static str> {
        match self {
            Backend::Refused(reason) => Some(reason),
            _ => None,
        }
    }

    /// The file's text (custody already checked) to a backend. `home`
    /// resolves the default usage summary path.
    pub(crate) fn parse(text: &str, home: &Path) -> Backend {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct File {
            format: String,
            backend: String,
            #[serde(default)]
            address: Option<String>,
            #[serde(default)]
            mount: Option<String>,
            #[serde(default)]
            prefix: Option<String>,
            #[serde(default)]
            role_id: Option<String>,
            #[serde(default)]
            secret_id: Option<String>,
            #[serde(default)]
            catalog: Option<String>,
            #[serde(default)]
            usage_summary: Option<String>,
            #[serde(default)]
            reveal_url: Option<String>,
        }
        let Ok(file) = serde_json::from_str::<File>(text) else {
            return Backend::Refused("invalid_json");
        };
        if file.format != FORMAT {
            return Backend::Refused("unknown_format");
        }
        let absolute = |value: Option<String>| -> Result<Option<PathBuf>, &'static str> {
            match value {
                None => Ok(None),
                Some(text) => {
                    let path = PathBuf::from(&text);
                    if path.is_absolute()
                        && !path
                            .components()
                            .any(|c| matches!(c, std::path::Component::ParentDir))
                    {
                        Ok(Some(path))
                    } else {
                        Err("path_not_absolute")
                    }
                }
            }
        };
        let usage = match absolute(file.usage_summary) {
            Ok(path) => path.or_else(|| Some(home.join("credentials-usage.json"))),
            Err(reason) => return Backend::Refused(reason),
        };
        match file.backend.as_str() {
            "v2_vault" => Backend::V2Vault { usage },
            "openbao" => {
                let Some(address) = file.address.as_deref().and_then(loopback::loopback_address)
                else {
                    return Backend::Refused("address_not_loopback_http");
                };
                let segment = |value: Option<String>, default: &str| {
                    let value = value.unwrap_or_else(|| default.to_owned());
                    let ok = (1..=64).contains(&value.len())
                        && value
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
                    ok.then_some(value)
                };
                let (Some(mount), Some(prefix)) = (
                    segment(file.mount, "orkestr"),
                    segment(file.prefix, "creds"),
                ) else {
                    return Backend::Refused("invalid_mount_or_prefix");
                };
                let credential = |value: Option<String>| {
                    value.filter(|v| {
                        (8..=256).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_graphic())
                    })
                };
                let (Some(role_id), Some(secret_id)) =
                    (credential(file.role_id), credential(file.secret_id))
                else {
                    return Backend::Refused("invalid_approle");
                };
                let reveal_url = match file.reveal_url {
                    None => None,
                    Some(url)
                        if url.starts_with("https://")
                            && url.contains("{id}")
                            && url.len() <= 512
                            && !url
                                .bytes()
                                .any(|b| b <= b' ' || b == b'"' || b == b'<' || b == b'>') =>
                    {
                        Some(url)
                    }
                    Some(_) => return Backend::Refused("invalid_reveal_url"),
                };
                let catalog = match absolute(file.catalog) {
                    Ok(path) => path,
                    Err(reason) => return Backend::Refused(reason),
                };
                Backend::OpenBao {
                    client: Arc::new(OpenBao::new(
                        address, mount, prefix, role_id, secret_id, reveal_url, catalog,
                    )),
                    usage,
                }
            }
            _ => Backend::Refused("unknown_backend"),
        }
    }

    /// Trusted startup: the environment's file or `<home>/credentials-backend.json`.
    pub(crate) fn load(home: &Path) -> Backend {
        let path = std::env::var_os(CONFIG_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("credentials-backend.json"));
        match super::private_file::read(&path, MAX_CONFIG, true) {
            Ok(None) => Backend::V2Vault {
                usage: Some(home.join("credentials-usage.json")),
            },
            Ok(Some(text)) => Backend::parse(&text, home),
            Err(super::private_file::Refused::Custody) => Backend::Refused("custody_rejected"),
            Err(_) => Backend::Refused("unreadable"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(extra: serde_json::Value) -> String {
        let mut base = json!({"format": FORMAT, "backend": "openbao", "address": "http://127.0.0.1:8200",
            "role_id": "00000000-0000-4000-8000-000000000001", "secret_id": "00000000-0000-4000-8000-000000000002"});
        for (k, v) in extra.as_object().unwrap() {
            if v.is_null() {
                base.as_object_mut().unwrap().remove(k);
            } else {
                base[k] = v.clone();
            }
        }
        base.to_string()
    }

    #[test]
    fn openbao_needs_a_loopback_address_and_an_approle() {
        let home = Path::new("/srv/synthetic-home");
        let Backend::OpenBao { client, usage } = Backend::parse(&config(json!({})), home) else {
            panic!("openbao expected");
        };
        assert_eq!(
            usage.as_deref(),
            Some(home.join("credentials-usage.json").as_path())
        );
        assert_eq!(client.reveal_url(), None);
        for (extra, reason) in [
            (
                json!({"address": "https://127.0.0.1:8200"}),
                "address_not_loopback_http",
            ),
            (
                json!({"address": "http://192.0.2.10:8200"}),
                "address_not_loopback_http",
            ),
            (json!({"secret_id": null}), "invalid_approle"),
            (json!({"mount": "a/b"}), "invalid_mount_or_prefix"),
            (
                json!({"reveal_url": "http://bao.example.invalid/{id}"}),
                "invalid_reveal_url",
            ),
            (json!({"catalog": "relative.json"}), "path_not_absolute"),
            (json!({"backend": "other"}), "unknown_backend"),
            (json!({"format": "v0"}), "unknown_format"),
            (json!({"surprise": true}), "invalid_json"),
        ] {
            assert_eq!(
                Backend::parse(&config(extra.clone()), home).rejection(),
                Some(reason),
                "{extra}"
            );
        }
        let with_ui = config(
            json!({"reveal_url": "https://bao.example.invalid/ui/vault/secrets/orkestr/show/creds/{id}"}),
        );
        let Backend::OpenBao { client, .. } = Backend::parse(&with_ui, home) else {
            panic!("openbao expected");
        };
        assert!(client.reveal_url().is_some());
    }

    #[test]
    fn without_a_file_the_built_in_vault_stays_the_store() {
        let home =
            std::env::temp_dir().join(format!("credentials-backend-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        assert_eq!(Backend::load(&home).name(), "v2_vault");
        std::fs::remove_dir_all(&home).unwrap();
    }
}
