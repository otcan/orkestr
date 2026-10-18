//! Pure ingress validation. No persistence, HTTP or runtime dependencies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    InvalidRequestKey,
    InvalidText,
    InvalidName,
}
pub fn request_key(key: &str) -> Result<(), ValidationError> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    {
        return Err(ValidationError::InvalidRequestKey);
    }
    Ok(())
}
pub fn message(key: &str, text: &str) -> Result<(), ValidationError> {
    request_key(key)?;
    if text.trim().is_empty() || text.len() > 32768 {
        return Err(ValidationError::InvalidText);
    }
    Ok(())
}
pub fn project(key: &str, name: &str) -> Result<(), ValidationError> {
    request_key(key)?;
    if name.trim().is_empty() || name.len() > 200 {
        return Err(ValidationError::InvalidName);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_and_keys() {
        assert!(message("a-1", "hello").is_ok());
        assert!(message("", "hello").is_err());
        assert!(message("key", "  ").is_err());
        assert!(message("key", &"a".repeat(32769)).is_err());
        assert!(project("key", "local").is_ok());
    }
}
