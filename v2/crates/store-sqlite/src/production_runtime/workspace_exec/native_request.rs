/// Wire correlation only. Possessing or constructing an ID grants no authority.
#[derive(Clone, PartialEq, Eq)]
pub enum WorkspaceExecNativeRequestId {
    Text(String),
    Integer(u64),
}
impl WorkspaceExecNativeRequestId {
    pub fn is_valid(&self) -> bool {
        match self {
            Self::Text(s) => !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control),
            // Codex numbers server requests from 0 in each app-server process.
            Self::Integer(n) => *n <= 9_007_199_254_740_991,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_request_id_preserves_kind_and_safe_bounds() {
        assert!(WorkspaceExecNativeRequestId::Text("1".into()).is_valid());
        assert!(WorkspaceExecNativeRequestId::Integer(1).is_valid());
        assert!(WorkspaceExecNativeRequestId::Integer(0).is_valid());
        assert!(
            WorkspaceExecNativeRequestId::Text("1".into())
                != WorkspaceExecNativeRequestId::Integer(1)
        );
        for id in [
            WorkspaceExecNativeRequestId::Integer(9_007_199_254_740_992),
            WorkspaceExecNativeRequestId::Text(String::new()),
            WorkspaceExecNativeRequestId::Text("bad\n".into()),
        ] {
            assert!(!id.is_valid());
        }
    }
}
