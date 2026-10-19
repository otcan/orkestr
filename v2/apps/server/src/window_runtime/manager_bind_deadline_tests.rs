use super::*;

#[test]
fn original_bind_deadline_is_converted_without_renewal() {
    let now = Instant::now();
    let deadline = now + Duration::from_secs(5);
    assert_eq!(bind_deadline_at(deadline, now, 1000), Ok(6000));
    assert_eq!(
        bind_deadline_at(deadline, now + Duration::from_secs(3), 4000),
        Ok(6000)
    );
    assert_eq!(
        bind_deadline_at(now + Duration::from_micros(1999), now, 1000),
        Ok(1001),
        "fractional milliseconds are rounded down, never extend the bound"
    );
}

#[test]
fn invalid_bind_deadline_refuses_before_wire_io() {
    let now = Instant::now();
    for deadline in [
        now - Duration::from_secs(1),
        now,
        now + Duration::from_nanos(999_999),
        now + Duration::from_millis(5001),
    ] {
        assert_eq!(
            bind_deadline_at(deadline, now, 1000),
            Err(ManagerError::Deadline)
        );
    }
    for wall in [u128::from(INTEGER_LIMIT) - 1, u128::MAX] {
        assert_eq!(
            bind_deadline_at(now + Duration::from_millis(1), now, wall),
            Err(ManagerError::Deadline)
        );
    }
    assert_eq!(
        bind_deadline_at(
            now + Duration::from_millis(1),
            now,
            u128::from(INTEGER_LIMIT) - 2
        ),
        Ok(INTEGER_LIMIT - 1)
    );
}
