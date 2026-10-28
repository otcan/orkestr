//! Original window tuple shared by the task and its paused-child setup gate.
use super::{
    clock::Clock,
    handles::{Generation, Handles},
    manager_client::{ManagerClient, Window},
};
use crate::execution_registry::ExecutionScope;
use orkestr_runtime::containment::metadata::BrokerChildLocator;
use orkestr_v2_contracts::ExecutionWindowStatus;
use orkestr_v2_store_sqlite::Store;
use std::time::Instant;

/// Extend when less than this much work time is left and work is still running.
const EXTEND_BELOW_MS: i64 = 600_000;
/// Each extension adds at least this much (and leaves at least EXTEND_BELOW_MS).
const EXTEND_STEP_MS: i64 = 600_000;

pub(crate) struct Context {
    pub(crate) manager: ManagerClient,
    /// Total lifetime ceiling for this window (opening to hard deadline).
    max_lifetime_ms: i64,
    /// Set once the ceiling is reached or an extension was refused.
    extension_closed: std::sync::atomic::AtomicBool,
    pub(crate) window: Window,
    pub(crate) boot: String,
    handles: Handles,
    clock: Clock,
    closed: std::sync::atomic::AtomicBool,
    retiring: std::sync::atomic::AtomicBool,
}
impl Context {
    pub(crate) fn new(
        manager: ManagerClient,
        handles: Handles,
        status: &ExecutionWindowStatus,
        boot: String,
        max_lifetime_ms: i64,
    ) -> Result<Self, &'static str> {
        let wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "window wall clock unavailable")?
            .as_millis();
        let wall = i64::try_from(wall).map_err(|_| "window clock overflow")?;
        Ok(Self {
            manager,
            max_lifetime_ms,
            extension_closed: std::sync::atomic::AtomicBool::new(false),
            handles,
            window: Window {
                window_id: status.window_id,
                generation: status.generation,
            },
            boot,
            clock: Clock::opening(status, wall, Instant::now())?,
            closed: std::sync::atomic::AtomicBool::new(false),
            retiring: std::sync::atomic::AtomicBool::new(false),
        })
    }
    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::Acquire)
    }
    pub(crate) fn work_due(&self) -> bool {
        self.clock.work_due(Instant::now())
    }
    pub(crate) fn cleanup_deadline(&self) -> tokio::time::Instant {
        self.clock.cleanup_deadline()
    }
    /// While a Deep or Worker run of this window is still working, keep at
    /// least EXTEND_BELOW_MS of work time by extending in steps, up to the
    /// window's lifetime ceiling. The manager records it first (a longer
    /// manager deadline is safe), then Core, then the local clock. Any refusal
    /// stops further attempts; the existing deadline handling then applies.
    pub(crate) async fn extend_while_working(&self, store: &Store, token: &str) -> bool {
        use std::sync::atomic::Ordering;
        if self.extension_closed.load(Ordering::Acquire) || self.is_closed() || self.work_due() {
            return false;
        }
        let Some(now) = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_millis()).ok())
        else {
            return false;
        };
        let current = self.clock.work_deadline_ms();
        if current - now >= EXTEND_BELOW_MS {
            return false;
        }
        let ceiling = self.clock.opened_at_ms() + self.max_lifetime_ms
            - orkestr_v2_store_sqlite::EXECUTION_WINDOW_CLEANUP_MS;
        let target = (current + EXTEND_STEP_MS)
            .max(now + EXTEND_BELOW_MS)
            .min(ceiling);
        if target <= current {
            self.extension_closed.store(true, Ordering::Release);
            return false;
        }
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let extended = self
            .manager
            .extend(
                &format!("extend:{}", uuid::Uuid::new_v4()),
                &self.window,
                target + orkestr_v2_store_sqlite::EXECUTION_WINDOW_CLEANUP_MS,
                deadline,
            )
            .await
            .is_ok()
            && store
                .extend_execution_window(
                    token,
                    self.window.window_id,
                    self.window.generation,
                    &self.boot,
                    target,
                    self.max_lifetime_ms,
                )
                .await
                .is_ok_and(|status| status.work_deadline_ms == target)
            && self.clock.extend_to(target).is_ok();
        if !extended {
            eprintln!("owned window extension refused; the current deadline applies");
            self.extension_closed.store(true, Ordering::Release);
        }
        extended
    }
    /// The share of this window's egress budget (attempts and bytes, the
    /// tighter of the two) still unused, from the manager's own receipt.
    /// `None` when the manager cannot say (callers fail closed).
    pub(crate) async fn egress_left(&self) -> Option<f64> {
        let deadline = Instant::now().checked_add(std::time::Duration::from_secs(2))?;
        let receipt = self
            .manager
            .status(&format!("status:{}", uuid::Uuid::new_v4()), deadline)
            .await
            .ok()?;
        let super::manager_client::ManagerReceipt::Window(receipt) = receipt else {
            return None;
        };
        if receipt.window_id != self.window.window_id
            || receipt.generation != self.window.generation
            || receipt.limits.attempts == 0
            || receipt.limits.bytes == 0
        {
            return None;
        }
        let attempts = 1.0 - f64::from(receipt.attempts) / f64::from(receipt.limits.attempts);
        let bytes = 1.0 - receipt.reserved_bytes as f64 / receipt.limits.bytes as f64;
        Some(attempts.min(bytes))
    }
    pub(crate) fn bind(&self, child: &BrokerChildLocator) -> Result<(), ()> {
        if self.work_due() {
            return Err(());
        }
        let deadline = Instant::now()
            .checked_add(std::time::Duration::from_secs(5))
            .ok_or(())?;
        self.manager
            .bind_child(
                &format!("bind:{}", uuid::Uuid::new_v4()),
                &self.window,
                child,
                deadline,
            )
            .and_then(|ack| {
                if ack.fresh_child
                    && ack.receipt.window_id == self.window.window_id
                    && ack.receipt.generation == self.window.generation
                {
                    Ok(())
                } else {
                    Err(super::manager_client::ManagerError::Protocol)
                }
            })
            .map_err(|_| ())
    }
    pub(crate) async fn activate_roles(
        &self,
        store: &Store,
        token: &str,
        scope: ExecutionScope,
        fast: Option<ExecutionScope>,
    ) -> Result<(), &'static str> {
        if self.work_due() {
            return Err("window work deadline elapsed before activation");
        }
        store
            .activate_execution_window(
                token,
                self.window.window_id,
                self.window.generation,
                &self.boot,
            )
            .await
            .map_err(|_| "window activation refused")?;
        self.handles.install_roles(
            Generation {
                window: self.window.window_id,
                number: self.window.generation,
            },
            scope,
            fast,
        )
    }
    pub(crate) async fn uncertain(&self, store: &Store, token: &str) {
        self.handles.poison();
        let _ = store
            .mark_execution_window_uncertain(
                token,
                self.window.window_id,
                self.window.generation,
                &self.boot,
            )
            .await;
        let reason = if store.authenticate(token).await.ok().flatten().is_none() {
            super::manager_client::Uncertainty::AuthRevoked
        } else if tokio::time::Instant::now() >= self.cleanup_deadline() {
            super::manager_client::Uncertainty::CleanupUnknown
        } else {
            super::manager_client::Uncertainty::RuntimeRefused
        };
        let _ = self
            .manager
            .uncertain(
                &format!("uncertain:{}", uuid::Uuid::new_v4()),
                &self.window,
                reason,
                Instant::now() + std::time::Duration::from_secs(2),
            )
            .await;
    }
    pub(crate) async fn begin_retirement(
        &self,
        store: &Store,
        token: &str,
    ) -> Result<(), &'static str> {
        if self.retiring.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        store
            .begin_execution_window_retirement(
                token,
                self.window.window_id,
                self.window.generation,
                &self.boot,
            )
            .await
            .map_err(|_| "window retirement transition refused")?;
        self.manager
            .drain(
                &format!("drain:{}", uuid::Uuid::new_v4()),
                &self.window,
                Instant::now() + std::time::Duration::from_secs(2),
            )
            .await
            .map_err(|_| "manager drain uncertain")?;
        self.retiring
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }
    /// Caller retains the original opaque native proof across this entire close.
    pub(crate) async fn close(
        &self,
        store: &Store,
        token: &str,
        run: &orkestr_v2_contracts::RunId,
    ) -> Result<(), &'static str> {
        let (_, retirement) = store
            .retire_execution_window(
                token,
                self.window.window_id,
                self.window.generation,
                &self.boot,
                run,
            )
            .await
            .map_err(|_| "window canonical close refused")?;
        let outcome = match retirement.outcome() {
            "accepted" => super::manager_client::TerminalOutcome::Accepted,
            "stopped" => super::manager_client::TerminalOutcome::Stopped,
            _ => return Err("window retirement provenance invalid"),
        };
        self.manager
            .retire(
                &format!("retire:{}", uuid::Uuid::new_v4()),
                &self.window,
                outcome,
                retirement.run_id().0,
                retirement.terminal_event_id().clone(),
                Instant::now() + std::time::Duration::from_secs(5),
            )
            .await
            .map_err(|_| "manager metadata retirement uncertain")?;
        self.handles.remove(Generation {
            window: self.window.window_id,
            number: self.window.generation,
        })?;
        self.closed
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }
}
