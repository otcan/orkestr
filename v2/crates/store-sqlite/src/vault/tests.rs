//! Vault store: owner-only sessions, sealing at rest, import idempotency and
//! the stored-login read path. Synthetic data only.
use super::*;
use crate::attachment_store::keys::ImportedRecipient;
use crate::attachment_store::seal::testing::{decrypt, identity};
use crate::Store;
use crate::{DesktopCaller, V1LeaseGrant};
use orkestr_v2_contracts::{ConversationId, DesktopBindingRequest};
use std::path::PathBuf;

const SECRET: &str = "synthetic-Vault-Secret-7781";
const BROWSER: &str = "browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MACHINE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SERVICE: &str = "browser:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const FENCE: &str = "fence-vault-0001";
const THREAD: &str = "thr_synthetic_vault";

struct Case {
    root: PathBuf,
    store: Store,
    owner: OwnerId,
    conversation: ConversationId,
    reader: age::x25519::Identity,
    reader_recipient: String,
}
impl Case {
    async fn new() -> Self {
        let base = std::env::var_os("ORKESTR_V2_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let root = base.join(format!("vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = crate::test_template::open(&root.join("core.sqlite3")).await;
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        store.save_session(BROWSER, &owner).await.unwrap();
        store.save_session(MACHINE, &owner).await.unwrap();
        sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at,kind) VALUES(?,?,unixepoch()+3600,'service_browser')")
            .bind(crate::digest(SERVICE)).bind(owner.to_string())
            .execute(&store.pool).await.unwrap();
        let (reader, reader_recipient) = identity();
        Self {
            root,
            store,
            owner,
            conversation,
            reader,
            reader_recipient,
        }
    }
    fn reader(&self) -> Option<&str> {
        Some(&self.reader_recipient)
    }
    async fn create(&self, name: &str, url: &str) -> VaultItemView {
        self.store
            .vault_create(BROWSER, self.reader(), &item(name, url))
            .await
            .unwrap()
    }
    /// Binds the desk to the conversation and records an active lease.
    async fn lease(&self, desk: &str) {
        let owner = DesktopCaller::Owner {
            credential: MACHINE,
            owner: &self.owner,
        };
        self.store
            .bind_desktops(
                MACHINE,
                &self.owner,
                &self.conversation,
                &DesktopBindingRequest {
                    expected_revision: 0,
                    v1_thread_id: THREAD.into(),
                    desktop_slugs: vec![desk.into()],
                },
            )
            .await
            .unwrap();
        let prepared = self
            .store
            .prepare_desktop_acquire(owner, &self.conversation, desk)
            .await
            .unwrap();
        self.store
            .record_desktop_acquired(
                owner,
                &self.conversation,
                &prepared,
                desk,
                &V1LeaseGrant {
                    lease_id: "synthetic-lease".into(),
                    fencing_token: FENCE.into(),
                    fencing_version: 1,
                    expires_at: None,
                },
                600_000,
            )
            .await
            .unwrap();
    }
    fn request(&self, site: &str) -> StoredLoginRequest {
        StoredLoginRequest {
            conversation_id: self.conversation.to_string(),
            desk: "owner-desk".into(),
            fencing_token: FENCE.into(),
            site: site.into(),
            mode: StoredLoginMode::Auto,
            item_ids: Vec::new(),
            operation: "op-synthetic-1".into(),
            check: false,
        }
    }
    async fn read(&self, request: &StoredLoginRequest) -> Result<StoredLogin> {
        self.store
            .vault_stored_login(&self.owner, &self.reader_recipient, request)
            .await
    }
    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .fetch_one(&self.store.pool)
            .await
            .unwrap()
    }
    async fn finish(self) {
        self.store.close().await;
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn item(name: &str, url: &str) -> ItemCreate {
    ItemCreate {
        name: name.into(),
        url: url.into(),
        username: "synthetic-user@example.com".into(),
        password: SECRET.into(),
        notes: "synthetic note".into(),
        tags: vec!["Work".into(), "work".into()],
    }
}
fn unbase64(text: &str) -> Vec<u8> {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes().filter(|c| *c != b'=') {
        acc = (acc << 6) | A.iter().position(|a| *a == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}
/// The sealed login opened with `identity`: (magic line ok, JSON).
fn open(identity: &age::x25519::Identity, base64: &str) -> serde_json::Value {
    let plain = decrypt(identity, &unbase64(base64)).expect("sealed for this identity");
    let text = String::from_utf8(plain).unwrap();
    let (magic, json) = text.split_once('\n').unwrap();
    assert_eq!(magic, LOGIN_MAGIC);
    serde_json::from_str(json).unwrap()
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

#[test]
fn domains_follow_v1_normalisation_and_the_site_rule() {
    assert_eq!(
        normalize_domain("https://www.Example.com:443/login?x=1").as_deref(),
        Some("example.com")
    );
    assert_eq!(
        normalize_domain("app.example.com/path").as_deref(),
        Some("app.example.com")
    );
    assert_eq!(
        normalize_domain("https://user@portal.example.org.").as_deref(),
        Some("portal.example.org")
    );
    assert_eq!(normalize_domain("").as_deref(), Some(""));
    for bad in [
        "https://[::1]/",
        "https://bad host/",
        "https://example.com:port/",
        "https://exämple.com/",
    ] {
        assert_eq!(normalize_domain(bad), None, "{bad}");
    }
    assert!(site_within("example.com", "example.com"));
    assert!(site_within("app.example.com", "example.com"));
    assert!(
        !site_within("example.com", "app.example.com"),
        "never a parent domain"
    );
    assert!(!site_within("badexample.com", "example.com"));
    assert!(!site_within("localhost", "localhost"), "needs a dot");
}

#[tokio::test]
async fn only_a_password_signed_in_browser_session_reaches_the_vault() {
    let case = Case::new().await;
    for refused in [
        MACHINE,
        SERVICE,
        "browser:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    ] {
        assert_eq!(
            case.store
                .vault_items(refused, case.reader())
                .await
                .unwrap_err(),
            VaultError::Unauthorized
        );
        assert_eq!(
            case.store
                .vault_create(
                    refused,
                    case.reader(),
                    &item("Synthetic", "https://example.com")
                )
                .await
                .unwrap_err(),
            VaultError::Unauthorized
        );
        assert_eq!(
            case.store
                .vault_import(refused, case.reader(), &import(&[("vi_synthetic01", 'a')]))
                .await
                .unwrap_err(),
            VaultError::Unauthorized
        );
    }
    assert_eq!(case.count("SELECT count(*) FROM vault_items").await, 0);
    let created = case.create("Synthetic", "https://example.com").await;
    assert_eq!(created.tags, vec!["work".to_string()]);
    assert_eq!(
        case.store
            .vault_items(BROWSER, case.reader())
            .await
            .unwrap(),
        vec![created]
    );
    case.finish().await;
}

#[tokio::test]
async fn logins_are_stored_only_as_ciphertext_bound_to_their_item() {
    let case = Case::new().await;
    let (browser, browser_recipient) = identity();
    case.store
        .import_attachment_recipients(
            &case.owner,
            &[ImportedRecipient {
                recipient: browser_recipient,
                label: "synthetic".into(),
                verified_at: 1,
            }],
        )
        .await
        .unwrap();
    let created = case
        .create("Synthetic Mail", "https://mail.example.com/login")
        .await;
    assert_eq!(created.domain, "mail.example.com");
    assert!(created.stored_login_ready && created.has_password);
    assert_eq!(created.recipients.len(), 2);
    // Neither the database nor its WAL holds the value.
    case.store.close().await;
    let mut bytes = std::fs::read(case.root.join("core.sqlite3")).unwrap();
    bytes.extend(std::fs::read(case.root.join("core.sqlite3-wal")).unwrap_or_default());
    assert!(!contains(&bytes, SECRET), "plaintext password at rest");
    assert!(
        !contains(&bytes, "synthetic-user@example.com"),
        "plaintext username at rest"
    );
    let store = Store::open(&case.root.join("core.sqlite3")).await.unwrap();
    let sealed = store.vault_sealed(BROWSER, &created.id).await.unwrap();
    // The owner's browser and the reader can both open it; it names its item and domain.
    for who in [&browser, &case.reader] {
        let login = open(who, &sealed.sealed_base64);
        assert_eq!(login["password"], SECRET);
        assert_eq!(login["item_id"], created.id.as_str());
        assert_eq!(login["domain"], "mail.example.com");
        assert_eq!(login["owner_id"], case.owner.to_string());
    }
    // Responses other than the sealed form carry no value.
    let listed =
        serde_json::to_string(&store.vault_items(BROWSER, case.reader()).await.unwrap()).unwrap();
    assert!(!listed.contains(SECRET) && !listed.contains("synthetic-user"));
    let audit = serde_json::to_string(&store.vault_audit(BROWSER, 50).await.unwrap()).unwrap();
    assert!(audit.contains("owner_reveal") && !audit.contains(SECRET));
    // No browser key and no reader: nothing to seal for.
    let empty = Case::new().await;
    assert_eq!(
        empty
            .store
            .vault_create(BROWSER, None, &item("x", "https://example.com"))
            .await
            .unwrap_err(),
        VaultError::Conflict("vault_recipient_required")
    );
    store.close().await;
    empty.finish().await;
    let _ = std::fs::remove_dir_all(&case.root);
}

#[tokio::test]
async fn edits_need_the_current_revision_and_replace_the_login_as_a_unit() {
    let case = Case::new().await;
    let created = case.create("Synthetic", "https://old.example.com").await;
    let stale = ItemUpdate {
        expected_revision: created.revision + 1,
        name: Some("x".into()),
        tags: None,
    };
    assert_eq!(
        case.store
            .vault_update(BROWSER, case.reader(), &created.id, &stale)
            .await
            .unwrap_err(),
        VaultError::Conflict("vault_item_changed")
    );
    let renamed = case
        .store
        .vault_update(
            BROWSER,
            case.reader(),
            &created.id,
            &ItemUpdate {
                expected_revision: created.revision,
                name: Some("Renamed".into()),
                tags: Some(vec![]),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (renamed.name.as_str(), renamed.revision),
        ("Renamed", created.revision + 1)
    );
    let replaced = case
        .store
        .vault_replace_login(
            BROWSER,
            case.reader(),
            &created.id,
            &LoginReplace {
                expected_revision: renamed.revision,
                url: "https://new.example.com".into(),
                username: "u".into(),
                password: "synthetic-new-secret".into(),
                notes: String::new(),
            },
        )
        .await
        .unwrap();
    assert_eq!(replaced.domain, "new.example.com");
    let sealed = case.store.vault_sealed(BROWSER, &created.id).await.unwrap();
    let login = open(&case.reader, &sealed.sealed_base64);
    assert_eq!(
        (login["password"].as_str(), login["domain"].as_str()),
        (Some("synthetic-new-secret"), Some("new.example.com"))
    );
    let granted = case
        .store
        .vault_set_grants(
            BROWSER,
            case.reader(),
            &created.id,
            &GrantsReplace {
                expected_revision: replaced.revision,
                v1_thread_ids: vec![THREAD.into(), THREAD.into()],
            },
        )
        .await
        .unwrap();
    assert_eq!(granted.thread_grants, vec![THREAD.to_string()]);
    case.store.vault_delete(BROWSER, &created.id).await.unwrap();
    assert_eq!(
        case.count("SELECT count(*) FROM vault_thread_grants").await,
        0
    );
    assert_eq!(
        case.store
            .vault_delete(BROWSER, &created.id)
            .await
            .unwrap_err(),
        VaultError::NotFound("vault_item_not_found")
    );
    case.finish().await;
}

fn entry(source_id: &str, checksum: char) -> ImportEntry {
    ImportEntry {
        source_id: source_id.into(),
        source_checksum: checksum.to_string().repeat(64),
        name: format!("Imported {source_id}"),
        url: "https://portal.example.net/login".into(),
        tags: vec!["imported".into()],
        username: "synthetic-imported-user".into(),
        password: format!("{SECRET}-{source_id}"),
        notes: String::new(),
        fields: vec![Field {
            name: "pin".into(),
            value: "0000".into(),
        }],
        totp: None,
        single_use: false,
        thread_grants: vec![ImportGrant {
            v1_thread_id: THREAD.into(),
            granted_at_ms: Some(1_700_000_000_000),
        }],
        created_at_ms: Some(1_700_000_000_000),
        updated_at_ms: Some(1_700_000_100_000),
        last_used_at_ms: None,
    }
}
fn import(entries: &[(&str, char)]) -> ImportRequest {
    ImportRequest {
        format: IMPORT_FORMAT.into(),
        source: "v1".into(),
        items: entries.iter().map(|(id, c)| entry(id, *c)).collect(),
    }
}
fn outcomes(report: &ImportReport) -> Vec<(&str, &str)> {
    report
        .items
        .iter()
        .map(|i| (i.source_id.as_str(), i.outcome))
        .collect()
}

#[tokio::test]
async fn importing_the_same_v1_vault_twice_changes_nothing() {
    let case = Case::new().await;
    let first = case
        .store
        .vault_import(
            BROWSER,
            case.reader(),
            &import(&[("vi_synthetic01", 'a'), ("vi_synthetic02", 'b')]),
        )
        .await
        .unwrap();
    assert_eq!(
        outcomes(&first),
        vec![
            ("vi_synthetic01", "imported"),
            ("vi_synthetic02", "imported")
        ]
    );
    // V1 ids are kept, grants and the V1 login time come along.
    let items = case
        .store
        .vault_items(BROWSER, case.reader())
        .await
        .unwrap();
    assert_eq!(
        items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        vec!["vi_synthetic01", "vi_synthetic02"]
    );
    assert!(items
        .iter()
        .all(|i| i.thread_grants == vec![THREAD.to_string()]
            && i.source.as_deref() == Some("v1")
            && i.login_updated_at_ms == 1_700_000_100_000));
    let sealed = case
        .store
        .vault_sealed(BROWSER, "vi_synthetic01")
        .await
        .unwrap();
    assert_eq!(
        open(&case.reader, &sealed.sealed_base64)["fields"][0]["value"],
        "0000"
    );
    let before = (
        case.count("SELECT count(*) FROM vault_items").await,
        case.count("SELECT count(*) FROM vault_audit WHERE event='import_applied'")
            .await,
        case.count("SELECT sum(revision) FROM vault_items").await,
    );
    let again = case
        .store
        .vault_import(
            BROWSER,
            case.reader(),
            &import(&[("vi_synthetic01", 'a'), ("vi_synthetic02", 'b')]),
        )
        .await
        .unwrap();
    assert_eq!((again.unchanged, again.imported, again.updated), (2, 0, 0));
    assert_eq!(
        (
            case.count("SELECT count(*) FROM vault_items").await,
            case.count("SELECT count(*) FROM vault_audit WHERE event='import_applied'")
                .await,
            case.count("SELECT sum(revision) FROM vault_items").await,
        ),
        before
    );
    // V1 changed item 1; the owner edited item 2 in V2 and V1 changed it too.
    let item2 = items.iter().find(|i| i.id == "vi_synthetic02").unwrap();
    case.store
        .vault_update(
            BROWSER,
            case.reader(),
            &item2.id,
            &ItemUpdate {
                expected_revision: item2.revision,
                name: Some("Owner renamed".into()),
                tags: None,
            },
        )
        .await
        .unwrap();
    let changed = case
        .store
        .vault_import(
            BROWSER,
            case.reader(),
            &import(&[("vi_synthetic01", 'c'), ("vi_synthetic02", 'd')]),
        )
        .await
        .unwrap();
    assert_eq!(
        outcomes(&changed),
        vec![
            ("vi_synthetic01", "updated"),
            ("vi_synthetic02", "conflict")
        ]
    );
    let names: Vec<String> = case
        .store
        .vault_items(BROWSER, case.reader())
        .await
        .unwrap()
        .into_iter()
        .map(|i| i.name)
        .collect();
    assert!(
        names.contains(&"Owner renamed".to_string()),
        "a conflict never overwrites the owner's edit"
    );
    // Re-running the updated import is unchanged again; a V2 deletion stays deleted.
    let rerun = case
        .store
        .vault_import(BROWSER, case.reader(), &import(&[("vi_synthetic01", 'c')]))
        .await
        .unwrap();
    assert_eq!(outcomes(&rerun), vec![("vi_synthetic01", "unchanged")]);
    case.store
        .vault_delete(BROWSER, "vi_synthetic01")
        .await
        .unwrap();
    let after_delete = case
        .store
        .vault_import(BROWSER, case.reader(), &import(&[("vi_synthetic01", 'e')]))
        .await
        .unwrap();
    assert_eq!(
        outcomes(&after_delete),
        vec![("vi_synthetic01", "deleted_in_v2")]
    );
    assert_eq!(
        case.count("SELECT count(*) FROM vault_items WHERE id='vi_synthetic01'")
            .await,
        0
    );
    // One request cannot name a source twice, and the report carries no value.
    assert_eq!(
        case.store
            .vault_import(
                BROWSER,
                case.reader(),
                &import(&[("vi_synthetic03", 'a'), ("vi_synthetic03", 'b')])
            )
            .await
            .unwrap_err(),
        VaultError::Invalid("vault_import_duplicate_source")
    );
    assert!(!serde_json::to_string(&changed).unwrap().contains(SECRET));
    case.finish().await;
}

#[tokio::test]
async fn the_stored_login_read_needs_the_lease_and_one_matching_login() {
    let case = Case::new().await;
    let mail = case
        .create("Synthetic Mail", "https://example.com/login")
        .await;
    // No lease, or a wrong fence: refused and audited, nothing returned.
    assert_eq!(
        case.read(&case.request("app.example.com"))
            .await
            .unwrap_err(),
        VaultError::Conflict("desk_lease_required")
    );
    case.lease("owner-desk").await;
    let mut wrong = case.request("app.example.com");
    wrong.fencing_token = "fence-vault-9999".into();
    assert_eq!(
        case.read(&wrong).await.unwrap_err(),
        VaultError::Conflict("desk_lease_required")
    );
    let mut other = case.request("app.example.com");
    other.desk = "other-desk".into();
    assert_eq!(
        case.read(&other).await.unwrap_err(),
        VaultError::Conflict("desk_lease_required")
    );
    // A subdomain of the stored domain gets the one login; the reader opens it.
    let found = case.read(&case.request("app.example.com")).await.unwrap();
    assert_eq!(
        (found.item_id.as_str(), found.domain.as_str()),
        (mail.id.as_str(), "example.com")
    );
    let login = open(&case.reader, found.sealed_base64.as_deref().unwrap());
    assert_eq!(
        (login["password"].as_str(), login["item_id"].as_str()),
        (Some(SECRET), Some(mail.id.as_str()))
    );
    // --check: metadata only.
    let mut check = case.request("example.com");
    check.check = true;
    assert!(case.read(&check).await.unwrap().sealed_base64.is_none());
    // A parent of the stored domain or a sibling never matches.
    let portal = case
        .create("Synthetic Portal", "https://portal.example.org")
        .await;
    assert_eq!(
        case.read(&case.request("example.org")).await.unwrap_err(),
        VaultError::NotFound("no_credential_for_site")
    );
    assert_eq!(
        case.read(&case.request("other.example.org"))
            .await
            .unwrap_err(),
        VaultError::NotFound("no_credential_for_site")
    );
    assert_eq!(
        case.read(&case.request("portal.example.org"))
            .await
            .unwrap()
            .item_id,
        portal.id
    );
    // Two logins for one site: refused, never guessed.
    case.create("Second Mail", "https://example.com").await;
    assert_eq!(
        case.read(&case.request("example.com")).await.unwrap_err(),
        VaultError::Conflict("credential_ambiguous")
    );
    // A login written before the reader existed is not handed out.
    let (_, browser_recipient) = identity();
    case.store
        .import_attachment_recipients(
            &case.owner,
            &[ImportedRecipient {
                recipient: browser_recipient,
                label: "b".into(),
                verified_at: 1,
            }],
        )
        .await
        .unwrap();
    case.store
        .vault_create(
            BROWSER,
            None,
            &item("Browser only", "https://browser.example.net"),
        )
        .await
        .unwrap();
    assert_eq!(
        case.read(&case.request("browser.example.net"))
            .await
            .unwrap_err(),
        VaultError::Conflict("credential_not_sealed_for_reader")
    );
    // Configured mode: the allow-list and the lease thread's grant decide.
    let mut configured = case.request("example.org");
    configured.mode = StoredLoginMode::Configured;
    configured.item_ids = vec![portal.id.clone()];
    assert_eq!(
        case.read(&configured).await.unwrap_err(),
        VaultError::NotFound("no_credential_for_site")
    );
    case.store
        .vault_set_grants(
            BROWSER,
            case.reader(),
            &portal.id,
            &GrantsReplace {
                expected_revision: portal.revision,
                v1_thread_ids: vec![THREAD.into()],
            },
        )
        .await
        .unwrap();
    assert_eq!(case.read(&configured).await.unwrap().item_id, portal.id);
    // Every answer is audited without a value.
    let events: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT event,detail FROM vault_audit WHERE event LIKE 'stored_login%' ORDER BY sequence",
    )
    .fetch_all(&case.store.pool)
    .await
    .unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|(e, _)| e == "stored_login_read")
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .filter(|(e, _)| e == "stored_login_check")
            .count(),
        1
    );
    assert!(events.contains(&(
        "stored_login_refused".into(),
        Some("desk_lease_required".into())
    )));
    assert!(events.contains(&(
        "stored_login_refused".into(),
        Some("credential_ambiguous".into())
    )));
    let rows: Vec<(String,)> = sqlx::query_as("SELECT coalesce(item_id,'')||coalesce(conversation_id,'')||coalesce(desk,'')||coalesce(site,'')||coalesce(operation,'')||coalesce(detail,'') FROM vault_audit")
        .fetch_all(&case.store.pool)
        .await
        .unwrap();
    assert!(rows.iter().all(|(r,)| !r.contains(SECRET)));
    case.finish().await;
}

#[test]
fn owner_addresses_must_be_https_with_a_dotted_host() {
    for ok in ["https://example.com", " HTTPS://App.Example.com/login "] {
        assert!(require_https_address(ok).is_ok(), "{ok}");
    }
    for (bad, code) in [
        ("", "vault_address_required"),
        ("http://example.com", "vault_address_not_https"),
        ("example.com", "vault_address_not_https"),
        ("https://", "vault_address_invalid"),
        ("https://localhost", "vault_address_invalid"),
        ("https://exämple.com", "vault_address_invalid"),
    ] {
        assert!(
            matches!(require_https_address(bad), Err(VaultError::Invalid(c)) if c == code),
            "{bad}"
        );
    }
}
