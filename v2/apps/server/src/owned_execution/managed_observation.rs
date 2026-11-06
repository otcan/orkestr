//! A bounded wait for Root observations, including its shared control queue.
use crate::window_runtime::manager_client::ManagerError;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// The existing control/setup allowance includes queueing behind other windows.
const CONTROL_ALLOWANCE: Duration = Duration::from_secs(5);

pub(super) fn deadline(work: Instant, lease_ms: i64) -> Result<Instant, ManagerError> {
    // Sample monotonic first: translating the later wall sample onto this
    // earlier Instant rounds toward an earlier lease deadline, never later.
    let now = Instant::now();
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ManagerError::Deadline)?;
    deadline_at(now, wall, work, lease_ms)
}

fn deadline_at(
    now: Instant,
    wall: Duration,
    work: Instant,
    lease_ms: i64,
) -> Result<Instant, ManagerError> {
    let lease = u64::try_from(lease_ms)
        .ok()
        .and_then(|ms| Duration::from_millis(ms).checked_sub(wall))
        .filter(|remaining| !remaining.is_zero())
        .and_then(|remaining| now.checked_add(remaining))
        .ok_or(ManagerError::Deadline)?;
    let control = now
        .checked_add(CONTROL_ALLOWANCE)
        .ok_or(ManagerError::Deadline)?;
    let deadline = control.min(work).min(lease);
    if deadline <= now {
        return Err(ManagerError::Deadline);
    }
    Ok(deadline)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_wait_uses_earliest_control_work_and_lease_bound() {
        let now = Instant::now();
        let wall = Duration::from_micros(1_000_500);
        for (work_ms, lease_ms, expected_us) in [
            (10_000, 20_000, 5_000_000),
            (2_000, 20_000, 2_000_000),
            (10_000, 2_000, 999_500),
        ] {
            assert_eq!(
                deadline_at(now, wall, now + Duration::from_millis(work_ms), lease_ms),
                Ok(now + Duration::from_micros(expected_us))
            );
        }
        for work in [now, now - Duration::from_millis(1)] {
            assert_eq!(
                deadline_at(now, wall, work, 20_000),
                Err(ManagerError::Deadline)
            );
        }
        for lease_ms in [-1, 0, 999, 1_000] {
            assert_eq!(
                deadline_at(now, wall, now + CONTROL_ALLOWANCE, lease_ms),
                Err(ManagerError::Deadline)
            );
        }
    }

    #[tokio::test]
    async fn queued_observation_can_complete_after_one_second_without_renewal() {
        let now = Instant::now();
        let bound = deadline_at(
            now,
            Duration::from_secs(1),
            now + Duration::from_secs(2),
            4_000,
        )
        .unwrap();
        let result = tokio::time::timeout_at(bound.into(), async {
            tokio::time::sleep(Duration::from_millis(1_100)).await;
            17
        })
        .await;
        assert_eq!(result, Ok(17));
        assert_eq!(bound, now + Duration::from_secs(2));
    }

    #[tokio::test]
    async fn queue_wait_cannot_spend_run_lease_or_window_cleanup_margin() {
        for (work_ms, lease_ms) in [(30, 3_000), (2_000, 1_030)] {
            let now = Instant::now();
            let bound = deadline_at(
                now,
                Duration::from_secs(1),
                now + Duration::from_millis(work_ms),
                lease_ms,
            )
            .unwrap();
            assert!(tokio::time::timeout_at(bound.into(), async {
                tokio::time::sleep(Duration::from_millis(100)).await;
            })
            .await
            .is_err());
        }
    }
}
