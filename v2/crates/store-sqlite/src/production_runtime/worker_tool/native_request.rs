/// Wire correlation only. Possessing or constructing an ID grants no authority.
#[derive(Clone, PartialEq, Eq)]
pub enum OfflinePythonNativeRequestId {
    Text(String),
    Integer(u64),
}
impl OfflinePythonNativeRequestId {
    pub fn is_valid(&self) -> bool {
        match self {
            Self::Text(s) => !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control),
            Self::Integer(n) => (1..=9_007_199_254_740_991).contains(n),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_request_id_preserves_kind_and_safe_bounds() {
        assert!(OfflinePythonNativeRequestId::Text("1".into()).is_valid());
        assert!(OfflinePythonNativeRequestId::Integer(1).is_valid());
        assert!(
            OfflinePythonNativeRequestId::Text("1".into())
                != OfflinePythonNativeRequestId::Integer(1)
        );
        for id in [
            OfflinePythonNativeRequestId::Integer(0),
            OfflinePythonNativeRequestId::Integer(9_007_199_254_740_992),
            OfflinePythonNativeRequestId::Text(String::new()),
            OfflinePythonNativeRequestId::Text("bad\n".into()),
        ] {
            assert!(!id.is_valid());
        }
    }
}
