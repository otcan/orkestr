//! Test-only: one migrated database per test binary, copied for each test that
//! needs a new store.
//!
//! A new store is expensive twice over. `Store::open` commits every migration
//! with a full fsync, and when it is handed a file that already exists it first
//! replays every migration in memory to identify it. A copy of the template
//! needs neither: this binary created the template with `Store::open` and had
//! `Store::open` accept a copy of it as an existing database before any test
//! saw it. So a copy is connected exactly as `Store::open` connects a database
//! it has identified, and only that identification is left out.
//!
//! Tests about migrating, upgrading, preflight or historical schemas keep
//! running real migrations: they build their own files, or hold
//! [`real_migrations`]. A test that reopens its store calls `Store::open`
//! itself and gets the whole of it.
//!
//! The template is a file under the test home, so every process of a run shares
//! it: a runner that starts one process per test, and the children some tests
//! spawn, copy it too instead of each migrating once more.
use crate::Store;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    cell::Cell,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::UNIX_EPOCH,
};

static TEMPLATE: OnceLock<PathBuf> = OnceLock::new();

thread_local! {
    /// `Some(n)`: this test holds [`real_migrations`] and created `n` stores under it.
    static REAL: Cell<Option<u32>> = const { Cell::new(None) };
}

pub(crate) struct RealMigrations(());

impl Drop for RealMigrations {
    fn drop(&mut self) {
        let created = REAL.with(Cell::take);
        // The guard belongs to the test's own thread. A fixture that moved to
        // another thread would get the template without anyone noticing.
        if !std::thread::panicking() {
            assert_ne!(created, Some(0), "real_migrations() covered no new store");
        }
    }
}

/// While the guard lives, stores this test creates run every migration.
pub(crate) fn real_migrations() -> RealMigrations {
    REAL.with(|real| real.set(Some(0)));
    RealMigrations(())
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

/// Names the template after every embedded migration and after this very test
/// binary, so no process copies a database that other code created.
fn name() -> String {
    let mut digest = Sha256::new();
    for migration in sqlx::migrate!("./migrations").iter() {
        digest.update(migration.version.to_le_bytes());
        digest.update(&migration.checksum);
    }
    let binary = std::fs::metadata(std::env::current_exe().unwrap()).unwrap();
    digest.update(binary.len().to_le_bytes());
    let modified = binary.modified().unwrap();
    digest.update(
        modified
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .to_le_bytes(),
    );
    let digest = format!("{:x}", digest.finalize());
    format!("store-template-{}", &digest[..16])
}

/// Migrates a database in a directory of its own, has `Store::open` accept a
/// copy of it, and moves another copy to `template`. Processes that race here
/// each publish an equivalent file; the rename is atomic, so a reader sees a
/// whole template or none.
fn publish(template: &Path) {
    let private = suffixed(
        template,
        &format!(".{}-{}", std::process::id(), uuid::Uuid::new_v4()),
    );
    std::fs::create_dir(&private).unwrap();
    let path = private.join("core.sqlite3");
    let staged = private.join("template");
    let reopened = private.join("reopened.sqlite3");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let store = Store::open(&path).await.unwrap();
            let checkpoint = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .fetch_one(&store.pool)
                .await
                .unwrap();
            assert_eq!(checkpoint.get::<i64, _>(0), 0, "template checkpoint");
            // The database file alone now holds every page. Take it while the
            // store is open: `close` can return before SQLite has removed the
            // WAL file, so that file's absence is no usable signal.
            std::fs::copy(&path, &staged).unwrap();
            let wal = std::fs::metadata(suffixed(&path, "-wal")).map_or(0, |wal| wal.len());
            assert_eq!(wal, 0, "template changed while it was copied");
            store.close().await;
            // The one full open that stands for every copy handed out later.
            std::fs::copy(&staged, &reopened).unwrap();
            Store::open(&reopened).await.unwrap().close().await;
        });
    std::fs::rename(&staged, template).unwrap();
    // Best effort: SQLite may still be removing its own files in there.
    let _ = std::fs::remove_dir_all(&private);
}

fn template() -> &'static Path {
    TEMPLATE.get_or_init(|| {
        let base = std::env::var_os("ORKESTR_V2_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&base).unwrap();
        let template = base.canonicalize().unwrap().join(name());
        if !template.exists() {
            // Its own thread and runtime: the first caller may be a
            // single-threaded test runtime, which cannot block on itself.
            let target = template.clone();
            std::thread::spawn(move || publish(&target)).join().unwrap();
        }
        template
    })
}

/// A new store at `path`, which must not exist yet, with the schema
/// `Store::open` gives an empty file.
pub(crate) async fn open(path: &Path) -> Store {
    if let Some(created) = REAL.with(Cell::get) {
        REAL.with(|real| real.set(Some(created + 1)));
        return Store::open(path).await.unwrap();
    }
    crate::paths::validate(path).unwrap();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        assert!(!suffixed(path, suffix).exists(), "store path is not new");
    }
    std::fs::copy(template(), path).unwrap();
    Store::connect_validated(path, false, true).await.unwrap()
}
