//! Reject protocol-inexact integers before opening the manager socket.
const MAX_EXCLUSIVE: u64 = 1 << 53;
pub(super) fn generation(value: u64) -> Result<u64, &'static str> {
    if value < MAX_EXCLUSIVE {
        Ok(value)
    } else {
        Err("window integer exceeds manager protocol range")
    }
}
pub(super) fn timestamp(value: i64) -> Result<u64, &'static str> {
    generation(u64::try_from(value).map_err(|_| "negative window timestamp")?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_integer_bounds_refuse_without_rounding() {
        assert_eq!(generation((1 << 53) - 1), Ok((1 << 53) - 1));
        assert!(generation(1 << 53).is_err());
        assert!(generation(i64::MAX as u64).is_err());
        assert!(generation(u64::MAX).is_err());
        assert!(timestamp(-1).is_err());
        assert_eq!(timestamp(0), Ok(0));
    }
}
