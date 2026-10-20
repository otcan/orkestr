//! Trusted operations are recovered only from Core's consumed, audited source
//! text. Runtime's decoder is the sole producer of the reserved job prefix.
use orkestr_runtime::broker::workspace_tool::JOB_PREFIX;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Control {
    Status,
    Wait,
    Cancel,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Operation<'a> {
    Command(&'a str),
    Start(&'a str),
    Status(Uuid),
    Wait(Uuid),
    Cancel(Uuid),
}

impl<'a> Operation<'a> {
    /// `None` is a malformed reserved operation: refuse, never run it as shell.
    pub(super) fn parse(source: &'a str) -> Option<Self> {
        let Some(rest) = source.strip_prefix(JOB_PREFIX) else {
            return Some(Self::Command(source));
        };
        if let Some(command) = rest.strip_prefix("start\n") {
            return (!command.is_empty()).then_some(Self::Start(command));
        }
        let (action, id) = rest.split_once(' ')?;
        let id = Uuid::parse_str(id)
            .ok()
            .filter(|parsed| parsed.hyphenated().to_string() == id)?;
        match action {
            "status" => Some(Self::Status(id)),
            "wait" => Some(Self::Wait(id)),
            "cancel" => Some(Self::Cancel(id)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_canonical_job_text_selects_a_job_operation() {
        let id = Uuid::new_v4();
        assert_eq!(
            Operation::parse("ls -la"),
            Some(Operation::Command("ls -la"))
        );
        assert_eq!(
            Operation::parse("#!orkestr-job start\ncargo test"),
            Some(Operation::Start("cargo test"))
        );
        assert_eq!(
            Operation::parse(&format!("#!orkestr-job wait {id}")),
            Some(Operation::Wait(id))
        );
        assert_eq!(
            Operation::parse(&format!("#!orkestr-job cancel {id}")),
            Some(Operation::Cancel(id))
        );
        for bad in [
            "#!orkestr-job start\n".to_owned(),
            "#!orkestr-job start cargo".to_owned(),
            format!("#!orkestr-job kill {id}"),
            format!("#!orkestr-job status {}", id.simple()),
            format!("#!orkestr-job status {}", id.to_string().to_uppercase()),
            "#!orkestr-job status ../x".to_owned(),
        ] {
            assert_eq!(Operation::parse(&bad), None, "{bad}");
        }
    }
}
