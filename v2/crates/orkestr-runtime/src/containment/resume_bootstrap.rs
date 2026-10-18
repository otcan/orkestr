//! Private bootstrap selected exclusively from a fenced Core metadata grant.
use super::Error;
use orkestr_v2_application::runtime::ProviderKind;

pub(super) enum ResumeBootstrap<'a> {
    Codex(&'a str),
    Claude(&'a str),
}

impl<'a> ResumeBootstrap<'a> {
    pub(super) fn from_grant(provider: ProviderKind, native: &'a str) -> Result<Self, Error> {
        match provider {
            ProviderKind::Codex => Ok(Self::Codex(native)),
            ProviderKind::Claude => Ok(Self::Claude(native)),
            _ => Err(Error::AuthorityProtocol),
        }
    }

    pub(super) fn payload(self) -> Result<Vec<u8>, Error> {
        let (prefix, native): (&[u8], &str) = match self {
            Self::Codex(native) => {
                if native.is_empty() || native.len() > 512 || native.chars().any(char::is_control) {
                    return Err(Error::InvalidFrame);
                }
                (b"codex-resume-v1\0", native)
            }
            Self::Claude(native) => {
                // Canonical lowercase UUID wire form; no caller-selected argv or prefix.
                if native.len() != 36
                    || !native.bytes().enumerate().all(|(i, b)| {
                        if matches!(i, 8 | 13 | 18 | 23) {
                            b == b'-'
                        } else {
                            b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                        }
                    })
                {
                    return Err(Error::InvalidFrame);
                }
                (b"claude-resume-v1\0", native)
            }
        };
        Ok([prefix, native.as_bytes()].concat())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_provider_bootstrap_and_closed_native_grammar() {
        let uuid = "12345678-1234-1234-1234-123456789abc";
        assert_eq!(
            ResumeBootstrap::from_grant(ProviderKind::Claude, uuid)
                .unwrap()
                .payload()
                .unwrap(),
            [b"claude-resume-v1\0".as_slice(), uuid.as_bytes()].concat()
        );
        assert_eq!(
            ResumeBootstrap::Codex("thread-1").payload().unwrap(),
            b"codex-resume-v1\0thread-1"
        );
        for bad in [
            "",
            "thread-1",
            "12345678-1234-1234-1234-123456789ABC",
            "12345678_1234-1234-1234-123456789abc",
        ] {
            assert_eq!(
                ResumeBootstrap::Claude(bad).payload(),
                Err(Error::InvalidFrame)
            );
        }
        assert_eq!(
            ResumeBootstrap::Codex("thread\n1").payload(),
            Err(Error::InvalidFrame)
        );
        assert!(ResumeBootstrap::from_grant(ProviderKind::ExplicitFixture, uuid).is_err());
    }
}
