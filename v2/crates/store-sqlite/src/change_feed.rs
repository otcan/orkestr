//! Commit-time change notifications for the browser live channel.
//!
//! Every pooled connection gets SQLite update, commit and rollback hooks. The
//! update hook only records that a row of a watched table changed; the commit
//! hook then bumps one shared revision, so a reader learns "something
//! committed" without polling. Rolled back changes are dropped. Lease, session
//! and supervisor heartbeats rewrite rows every second without changing what
//! any page shows, so they never count. The hooks run inside SQLite on the
//! connection's worker thread: they only touch atomics and a watch channel,
//! never the connection, and cannot panic.
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

/// Tables whose writes are liveness bookkeeping only (lease deadlines,
/// supervisor heartbeats, browser and machine sessions).
const IGNORED: [&str; 5] = [
    "auth_sessions",
    "production_supervisors",
    "production_run_leases",
    "fixture_supervisors",
    "fixture_run_leases",
];

/// Whether a write to `table` can change what a page shows.
pub fn counts(table: &str) -> bool {
    !IGNORED.contains(&table)
}

/// The store's commit revision. A store opened without hooks (upgrade
/// fixtures) never changes it.
#[derive(Clone)]
pub struct ChangeFeed {
    revision: Arc<watch::Sender<u64>>,
    born: Instant,
    /// Milliseconds after `born` of the last counted commit, plus one (zero:
    /// none yet).
    last: Arc<AtomicU64>,
}

impl Default for ChangeFeed {
    fn default() -> Self {
        Self {
            revision: Arc::new(watch::channel(0).0),
            born: Instant::now(),
            last: Arc::default(),
        }
    }
}

impl ChangeFeed {
    /// How long ago the last counted commit was (`None`: none since open).
    pub fn quiet_for(&self) -> Option<Duration> {
        match self.last.load(Ordering::Relaxed) {
            0 => None,
            at => Some(
                self.born
                    .elapsed()
                    .saturating_sub(Duration::from_millis(at - 1)),
            ),
        }
    }
    /// A receiver that wakes after each commit of a counted change.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }
    /// The current revision (monotonic, wraps only after 2^64 commits).
    pub fn revision(&self) -> u64 {
        *self.revision.borrow()
    }
    /// Records one committed change (also used by tests and by writers that
    /// change state outside SQLite).
    pub fn bump(&self) {
        let at = u64::try_from(self.born.elapsed().as_millis()).unwrap_or(u64::MAX - 1);
        self.last.store(at.saturating_add(1), Ordering::Relaxed);
        self.revision.send_modify(|r| *r = r.wrapping_add(1));
    }
    /// Installs the hooks on one new pooled connection.
    pub(crate) async fn install(
        &self,
        connection: &mut sqlx::SqliteConnection,
    ) -> Result<(), sqlx::Error> {
        let pending = Arc::new(AtomicBool::new(false));
        let mut handle = connection.lock_handle().await?;
        let updated = pending.clone();
        handle.set_update_hook(move |change| {
            if counts(change.table) {
                updated.store(true, Ordering::Relaxed);
            }
        });
        let committed = pending.clone();
        let feed = self.clone();
        handle.set_commit_hook(move || {
            if committed.swap(false, Ordering::Relaxed) {
                feed.bump();
            }
            // Never turn the commit into a rollback.
            true
        });
        handle.set_rollback_hook(move || pending.store(false, Ordering::Relaxed));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_tables_do_not_count() {
        for table in IGNORED {
            assert!(!counts(table), "{table}");
        }
        for table in [
            "events",
            "messages",
            "production_runs",
            "sidebar_read_marks",
        ] {
            assert!(counts(table), "{table}");
        }
    }

    #[tokio::test]
    async fn pooled_commits_count_and_heartbeats_and_rollbacks_do_not() {
        let case = crate::conversation_resources::tests_settings::Case::new().await;
        let feed = case.store.changes().clone();
        let mut receiver = feed.subscribe();
        receiver.borrow_and_update();
        // A browser session is a heartbeat-class write.
        case.store
            .save_session(&"a".repeat(64), &case.owner)
            .await
            .unwrap();
        assert!(!receiver.has_changed().unwrap(), "sessions do not count");
        // A conversation the owner creates does.
        let before = feed.revision();
        case.conversation("live-feed").await;
        assert!(feed.revision() > before, "a committed change counts");
        // A rolled back write does not.
        let before = feed.revision();
        let mut tx = case.store.pool.begin().await.unwrap();
        sqlx::query("UPDATE conversations SET sequence=sequence WHERE owner_id=?")
            .bind(case.owner.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(feed.revision(), before, "a rollback does not count");
        case.finish().await;
    }

    #[test]
    fn a_bump_wakes_subscribers() {
        let feed = ChangeFeed::default();
        let mut receiver = feed.subscribe();
        assert_eq!(feed.revision(), 0);
        assert_eq!(feed.quiet_for(), None);
        feed.bump();
        assert!(receiver.has_changed().unwrap());
        assert_eq!(*receiver.borrow_and_update(), 1);
        assert!(feed.quiet_for().unwrap() < Duration::from_secs(5));
    }
}
