use super::*;
use sha2::{Digest, Sha256};

pub(super) fn render(output: &WorkspaceExecOutput) -> Result<(String, String, bool)> {
    if output.stdout.len().saturating_add(output.stderr.len()) > 128 * 1024
        || output.exit_code.is_some_and(|v| !(0..=255).contains(&v))
        || output.signal.is_some_and(|v| !(1..=64).contains(&v))
        || output.exit_code.is_some() == output.signal.is_some()
    {
        return Err(RuntimeStoreError::InvalidInput);
    }
    let mut digest = Sha256::new();
    digest.update(b"orkestr-workspace-exec-output-v1\0");
    for bytes in [&output.stdout, &output.stderr] {
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    digest.update(output.exit_code.map(i64::from).unwrap_or(-1).to_be_bytes());
    digest.update(output.signal.map(i64::from).unwrap_or(-1).to_be_bytes());
    let stdout = bounded_text(&output.stdout);
    let stderr = bounded_text(&output.stderr);
    let text = format!(
        "exit_code={:?} signal={:?}\nstdout:\n{}\nstderr:\n{}",
        output.exit_code, output.signal, stdout, stderr
    );
    debug_assert!(text.len() <= 8192);
    Ok((
        format!("{:x}", digest.finalize()),
        text,
        output.exit_code == Some(0) && output.signal.is_none(),
    ))
}
/// First 1 KiB and last 2 KiB: build failures report their cause at the end.
fn bounded_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= 3072 {
        return text.into_owned();
    }
    let mut end = 1024;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut start = text.len() - 2048;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!(
        "{}\n[truncated; original {} bytes]\n{}",
        &text[..end],
        bytes.len(),
        &text[start..]
    )
}

pub(super) fn response_digest(text: &str, success: bool) -> String {
    hash(
        "workspace-exec-native-response-v1",
        &[if success { "1" } else { "0" }, text],
    )
}
