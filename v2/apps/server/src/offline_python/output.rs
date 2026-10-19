use super::*;
use sha2::{Digest, Sha256};

/// Domain prefix, then stdout/stderr as u64 big-endian byte length + exact bytes,
/// then signed i64 big-endian exit code/signal, with -1 for an absent value.
pub(super) fn digest(output: &WorkerOutput) -> String {
    let mut digest = Sha256::new();
    digest.update(b"orkestr-offline-python-output-v1\0");
    for bytes in [&output.stdout, &output.stderr] {
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    digest.update(output.exit_code.map(i64::from).unwrap_or(-1).to_be_bytes());
    digest.update(output.signal.map(i64::from).unwrap_or(-1).to_be_bytes());
    format!("{digest:x}", digest = digest.finalize())
}
pub(super) fn failure_digest(error: WorkerSandboxError) -> String {
    let label = match error {
        WorkerSandboxError::Unsupported => "unsupported",
        WorkerSandboxError::InvalidConfig => "invalid_config",
        WorkerSandboxError::InvalidInput => "invalid_input",
        WorkerSandboxError::Busy => "busy",
        WorkerSandboxError::Io => "io",
        WorkerSandboxError::Timeout => "timeout",
        WorkerSandboxError::OutputLimit => "output_limit",
        WorkerSandboxError::Cancelled => "cancelled",
    };
    let mut digest = Sha256::new();
    digest.update(b"orkestr-offline-python-failure-v1\0");
    digest.update(label.as_bytes());
    format!("{digest:x}", digest = digest.finalize())
}
