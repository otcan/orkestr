//! Closed Store failure classes only; observation never changes authority.
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::RunId;
use std::io::Write;

#[derive(Clone, Copy, Debug)]
pub enum Operation {
    WorkerTaskClaim,
    ManagedRunFence,
    MetadataSetupFence,
}

/// Call after the Store operation releases its durable fence. No provider text,
/// native identity, request data or raw database error is accepted here.
pub fn observe<T>(
    operation: Operation,
    parent: Option<&RunId>,
    result: Result<T, RuntimeStoreError>,
) -> Result<T, RuntimeStoreError> {
    if result.is_err() {
        observe_to(operation, parent, result, &mut std::io::stderr().lock())
    } else {
        result
    }
}

fn observe_to<T>(
    operation: Operation,
    parent: Option<&RunId>,
    result: Result<T, RuntimeStoreError>,
    writer: &mut impl Write,
) -> Result<T, RuntimeStoreError> {
    if let Err(error) = &result {
        // Keep RuntimeStoreError closed and value-free, even if future variants
        // gain payloads. An added variant must explicitly choose a safe class.
        let outcome = match error {
            RuntimeStoreError::InvalidInput => "InvalidInput",
            RuntimeStoreError::NotFound => "NotFound",
            RuntimeStoreError::Unauthorized => "Unauthorized",
            RuntimeStoreError::Busy => "Busy",
            RuntimeStoreError::StaleLease => "StaleLease",
            RuntimeStoreError::Fenced => "Fenced",
            RuntimeStoreError::Conflict => "Conflict",
            RuntimeStoreError::Expired => "Expired",
            RuntimeStoreError::Unavailable => "Unavailable",
        };
        if let Some(parent) = parent {
            let _ = writeln!(
                writer,
                "owned_store operation={operation:?} parent_run={parent} outcome={outcome}"
            );
        } else {
            let _ = writeln!(
                writer,
                "owned_store operation={operation:?} outcome={outcome}"
            );
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct BrokenWriter;
    impl Write for BrokenWriter {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
    }

    #[test]
    fn broken_sink_preserves_every_store_error() {
        let parent: RunId =
            serde_json::from_str(r#""00000000-0000-0000-0000-000000000001""#).unwrap();
        for operation in [
            Operation::WorkerTaskClaim,
            Operation::ManagedRunFence,
            Operation::MetadataSetupFence,
        ] {
            for error in [
                RuntimeStoreError::InvalidInput,
                RuntimeStoreError::NotFound,
                RuntimeStoreError::Unauthorized,
                RuntimeStoreError::Busy,
                RuntimeStoreError::StaleLease,
                RuntimeStoreError::Fenced,
                RuntimeStoreError::Conflict,
                RuntimeStoreError::Expired,
                RuntimeStoreError::Unavailable,
            ] {
                for parent in [None, Some(&parent)] {
                    assert_eq!(
                        observe_to::<()>(operation, parent, Err(error), &mut BrokenWriter),
                        Err(error)
                    );
                }
            }
        }
    }

    #[test]
    fn success_preserves_owned_value_without_writing() {
        struct NoWrites;
        impl Write for NoWrites {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                panic!("success must not write diagnostics")
            }
            fn flush(&mut self) -> std::io::Result<()> {
                panic!("success must not flush diagnostics")
            }
        }
        let value = Box::new(17);
        let address = std::ptr::from_ref(value.as_ref());
        let observed =
            observe_to(Operation::ManagedRunFence, None, Ok(value), &mut NoWrites).unwrap();
        assert_eq!(std::ptr::from_ref(observed.as_ref()), address);
    }
}
