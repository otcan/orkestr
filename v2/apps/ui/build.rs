//! Records build-script execution time in the artifact, never application startup.
use std::time::{SystemTime, UNIX_EPOCH};
fn main() {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("build clock before epoch")
        .as_secs();
    println!("cargo:rustc-env=ORKESTR_V2_COMPILED_AT_UNIX={timestamp}");
}
