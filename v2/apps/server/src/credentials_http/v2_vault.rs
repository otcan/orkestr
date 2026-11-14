//! The built-in vault behind the credentials page: the default store.
//!
//! Its items are site logins; a token or API key is kept in the password
//! field and tagged `type:token` / `type:api_key`. Chats are V1 thread ids
//! (its grants), the owner's desks may use every login sealed for the
//! stored-login reader, the site travels with the value (an `https://`
//! address inside the sealed login), and "show" opens the value in this
//! browser with its own key. Usage comes from the vault's own audit.
use super::model::{CredentialView, Kind, Usage};
use super::usage::Summary;
use orkestr_v2_store_sqlite::vault::{
    GrantsReplace, ItemCreate, ItemUpdate, LoginReplace, VaultError, VaultItemView,
};
use orkestr_v2_store_sqlite::Store;

const TYPE_TAG: &str = "type:";

fn kind_of(item: &VaultItemView) -> Kind {
    item.tags
        .iter()
        .find_map(|t| t.strip_prefix(TYPE_TAG).and_then(Kind::parse))
        .unwrap_or(Kind::Password)
}

fn tags_for(kind: Kind, old: &[String]) -> Vec<String> {
    let mut tags: Vec<String> = old
        .iter()
        .filter(|t| !t.starts_with(TYPE_TAG))
        .cloned()
        .collect();
    if kind != Kind::Password {
        tags.insert(0, format!("{TYPE_TAG}{}", kind.as_str()));
    }
    tags
}

pub(crate) fn view(item: &VaultItemView) -> CredentialView {
    let kind = kind_of(item);
    CredentialView {
        id: item.id.clone(),
        label: item.name.clone(),
        kind,
        site: item.domain.clone(),
        allowed: item.thread_grants.clone(),
        owner_desks: item.stored_login_ready && kind == Kind::Password,
        revision: item.revision.to_string(),
        updated_at_ms: Some(item.updated_at_ms),
        fields: if item.has_password {
            vec![kind.main_field().to_owned()]
        } else {
            Vec::new()
        },
        usage: Usage::default(),
    }
}

fn revision(expected: &str) -> Result<i64, VaultError> {
    expected
        .parse()
        .map_err(|_| VaultError::Conflict("vault_item_changed"))
}

/// The address the vault requires: the given sign-in address, else the site's root.
fn address(site: &str, url: Option<&str>) -> String {
    match url {
        Some(url) => url.to_owned(),
        None if site.is_empty() => String::new(),
        None => format!("https://{site}/"),
    }
}

pub(crate) struct NewCredential<'a> {
    pub(crate) kind: Kind,
    pub(crate) label: &'a str,
    pub(crate) site: &'a str,
    pub(crate) allowed: &'a [String],
    pub(crate) fields: &'a [(&'static str, &'a str)],
}

fn value<'a>(fields: &[(&'static str, &'a str)], name: &str) -> Option<&'a str> {
    fields.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
}

/// The vault as one owner session sees it.
pub(crate) struct Vault<'a> {
    pub(crate) store: &'a Store,
    pub(crate) credential: &'a str,
    pub(crate) reader: Option<&'a str>,
}

impl Vault<'_> {
    pub(crate) async fn list(
        &self,
        usage: &mut Summary,
    ) -> Result<Vec<CredentialView>, VaultError> {
        let (store, credential, reader) = (self.store, self.credential, self.reader);
        let items = store.vault_items(credential, reader).await?;
        // The vault's own record of stored-login reads: when and by which chat.
        for event in store.vault_audit(credential, 500).await? {
            if event.event == "stored_login_read" {
                if let Some(item) = &event.item_id {
                    usage.merge(item, event.at_ms, event.conversation_id.as_deref());
                }
            }
        }
        for item in &items {
            if let Some(at) = item.last_used_at_ms {
                usage.merge(&item.id, at, None);
            }
        }
        Ok(items.iter().map(view).collect())
    }

    pub(crate) async fn create(
        &self,
        new: NewCredential<'_>,
    ) -> Result<CredentialView, VaultError> {
        let (store, credential, reader) = (self.store, self.credential, self.reader);
        let secret = value(new.fields, new.kind.main_field()).unwrap_or_default();
        let item = store
            .vault_create(
                credential,
                reader,
                &ItemCreate {
                    name: new.label.to_owned(),
                    url: address(new.site, value(new.fields, "url")),
                    username: value(new.fields, "username").unwrap_or_default().to_owned(),
                    password: secret.to_owned(),
                    notes: value(new.fields, "notes").unwrap_or_default().to_owned(),
                    tags: tags_for(new.kind, &[]),
                },
            )
            .await?;
        if new.allowed.is_empty() {
            return Ok(view(&item));
        }
        let item = store
            .vault_set_grants(
                credential,
                reader,
                &item.id,
                &GrantsReplace {
                    expected_revision: item.revision,
                    v1_thread_ids: new.allowed.to_vec(),
                },
            )
            .await?;
        Ok(view(&item))
    }

    pub(crate) async fn update(
        &self,
        id: &str,
        expected: &str,
        label: Option<&str>,
        allowed: Option<&[String]>,
    ) -> Result<CredentialView, VaultError> {
        let (store, credential, reader) = (self.store, self.credential, self.reader);
        let mut revision = revision(expected)?;
        let current = store
            .vault_items(credential, reader)
            .await?
            .into_iter()
            .find(|i| i.id == id)
            .ok_or(VaultError::NotFound("vault_item_not_found"))?;
        let mut item = current.clone();
        if let Some(label) = label.filter(|l| *l != current.name) {
            item = store
                .vault_update(
                    credential,
                    reader,
                    id,
                    &ItemUpdate {
                        expected_revision: revision,
                        name: Some(label.to_owned()),
                        tags: None,
                    },
                )
                .await?;
            revision = item.revision;
        }
        if let Some(allowed) = allowed.filter(|a| *a != current.thread_grants.as_slice()) {
            item = store
                .vault_set_grants(
                    credential,
                    reader,
                    id,
                    &GrantsReplace {
                        expected_revision: revision,
                        v1_thread_ids: allowed.to_vec(),
                    },
                )
                .await?;
        }
        if item.revision == current.revision && current.revision.to_string() != expected {
            return Err(VaultError::Conflict("vault_item_changed"));
        }
        Ok(view(&item))
    }

    /// The vault replaces a login as a whole: address, username, value and notes.
    pub(crate) async fn replace_value(
        &self,
        id: &str,
        expected: &str,
        site: &str,
        kind: Kind,
        fields: &[(&'static str, &str)],
    ) -> Result<CredentialView, VaultError> {
        let (store, credential, reader) = (self.store, self.credential, self.reader);
        let item = store
            .vault_replace_login(
                credential,
                reader,
                id,
                &LoginReplace {
                    expected_revision: revision(expected)?,
                    url: address(site, value(fields, "url")),
                    username: value(fields, "username").unwrap_or_default().to_owned(),
                    password: value(fields, kind.main_field())
                        .unwrap_or_default()
                        .to_owned(),
                    notes: value(fields, "notes").unwrap_or_default().to_owned(),
                },
            )
            .await?;
        Ok(view(&item))
    }

    pub(crate) async fn current(&self, id: &str) -> Result<CredentialView, VaultError> {
        self.store
            .vault_items(self.credential, self.reader)
            .await?
            .iter()
            .find(|i| i.id == id)
            .map(view)
            .ok_or(VaultError::NotFound("vault_item_not_found"))
    }

    pub(crate) async fn delete(&self, id: &str, expected: &str) -> Result<(), VaultError> {
        if self.current(id).await?.revision != expected {
            return Err(VaultError::Conflict("vault_item_changed"));
        }
        self.store.vault_delete(self.credential, id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_travel_as_tags_and_logins_stay_passwords() {
        assert_eq!(
            tags_for(Kind::ApiKey, &["work".into(), "type:token".into()]),
            ["type:api_key", "work"]
        );
        assert_eq!(
            tags_for(Kind::Password, &["type:api_key".into()]),
            Vec::<String>::new()
        );
        assert_eq!(address("example.com", None), "https://example.com/");
        assert_eq!(
            address("example.com", Some("https://example.com/login")),
            "https://example.com/login"
        );
        assert_eq!(address("", None), "");
        assert!(revision("seven").is_err());
    }
}
