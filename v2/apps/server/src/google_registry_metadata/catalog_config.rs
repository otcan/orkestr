//! Explicit operator mapping. No registry discovery, credentials or initialization.
use super::{strict_json, RegistryBinding, RegistryCatalog};
use orkestr_v2_contracts::OwnerId;
use serde::Deserialize;
use std::path::{Path, PathBuf};
const LIMIT: u64 = 64 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    format: String,
    bindings: Vec<Binding>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    owner: OwnerId,
    legacy_registry_owner: String,
    path: PathBuf,
    identity_binding_reviewed: bool,
}
fn parse(bytes: &[u8]) -> Result<RegistryCatalog, &'static str> {
    let bad = "invalid private Google catalog";
    if bytes.len() as u64 > LIMIT {
        return Err(bad);
    }
    let descriptor: Descriptor =
        serde_json::from_value(strict_json::parse(bytes).map_err(|_| bad)?).map_err(|_| bad)?;
    if descriptor.format != "orkestr-google-registry-catalog-v1" || descriptor.bindings.len() > 128
    {
        return Err(bad);
    }
    let mut bindings = Vec::new();
    for binding in descriptor.bindings {
        if !binding.identity_binding_reviewed {
            return Err(bad);
        }
        bindings.push(RegistryBinding {
            owner: binding.owner,
            legacy_registry_owner: binding.legacy_registry_owner,
            path: binding.path,
        });
    }
    RegistryCatalog::new(bindings)
}
/// Root-owned, private regular descriptor under root-owned nonwritable ancestors.
/// Linux stable trusted namespace only. The review marker records an operator
/// assertion; this loader cannot establish cross-service identity equivalence.
#[cfg(target_os = "linux")]
pub fn load_private_catalog(path: &Path) -> Result<RegistryCatalog, &'static str> {
    use std::{
        fs::{File, OpenOptions},
        io::Read,
        os::{
            fd::AsRawFd,
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        path::Component,
    };
    let bad = "private Google catalog custody rejected";
    const NOFOLLOW: i32 = 0x20000;
    const DIRECTORY: i32 = 0x10000;
    const NONBLOCK: i32 = 0x800;
    let parts: Vec<_> = path.components().collect();
    if !path.is_absolute()
        || parts.len() < 2
        || parts
            .iter()
            .skip(1)
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(bad);
    }
    let open = |path: &Path, flags| {
        OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open(path)
            .map_err(|_| bad)
    };
    let trusted = |file: &File, directory: bool| -> Result<(), &'static str> {
        let m = file.metadata().map_err(|_| bad)?;
        if m.uid() != 0 || m.mode() & 0o022 != 0 || (directory && !m.is_dir()) {
            return Err(bad);
        }
        Ok(())
    };
    let mut directory = open(Path::new("/"), DIRECTORY | NOFOLLOW)?;
    trusted(&directory, true)?;
    for part in &parts[1..parts.len() - 1] {
        let child = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
            .join(part.as_os_str());
        directory = open(&child, DIRECTORY | NOFOLLOW)?;
        trusted(&directory, true)?;
    }
    let child = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
        .join(parts.last().ok_or(bad)?.as_os_str());
    let file = open(&child, NOFOLLOW | NONBLOCK)?;
    trusted(&file, false)?;
    let before = file.metadata().map_err(|_| bad)?;
    if !before.is_file()
        || before.nlink() != 1
        || before.mode() & 0o007 != 0
        || before.len() > LIMIT
    {
        return Err(bad);
    }
    let mut bounded = file.take(LIMIT + 1);
    let mut bytes = Vec::new();
    bounded.read_to_end(&mut bytes).map_err(|_| bad)?;
    let after = bounded.get_ref().metadata().map_err(|_| bad)?;
    let identity = |m: &std::fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    if identity(&before) != identity(&after) {
        return Err(bad);
    }
    parse(&bytes)
}
#[cfg(not(target_os = "linux"))]
pub fn load_private_catalog(_: &Path) -> Result<RegistryCatalog, &'static str> {
    Err("private Google catalog requires Linux")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_descriptor_refuses_ambiguous_authority() {
        assert!(parse(br#"{"format":"orkestr-google-registry-catalog-v1","bindings":[]}"#).is_ok());
        for raw in [
            br#"{"format":"orkestr-google-registry-catalog-v1","bindings":[],"extra":true}"#
                .as_slice(),
            br#"{"format":"orkestr-google-registry-catalog-v1","bindings":[],"bindings":[]}"#,
            br#"{"format":"wrong","bindings":[]}"#,
        ] {
            assert!(parse(raw).is_err());
        }
        assert!(parse(&vec![b' '; LIMIT as usize + 1]).is_err());
    }
    #[test]
    fn explicit_binding_and_duplicate_owner_policy() {
        let binding = serde_json::json!({
            "owner":"11111111-1111-4111-8111-111111111111",
            "legacy_registry_owner":"synthetic-legacy-owner",
            "path":"/operator/registries/google-workspace-connections.json",
            "identity_binding_reviewed":true
        });
        let descriptor = |rows| {
            serde_json::to_vec(
                &serde_json::json!({"format":"orkestr-google-registry-catalog-v1","bindings":rows}),
            )
            .unwrap()
        };
        assert!(parse(&descriptor(vec![binding.clone()])).is_ok());
        assert!(parse(&descriptor(vec![binding.clone(), binding.clone()])).is_err());
        let mut unreviewed = binding;
        unreviewed["identity_binding_reviewed"] = false.into();
        assert!(parse(&descriptor(vec![unreviewed])).is_err());
    }
    #[test]
    fn missing_or_untrusted_descriptor_refuses() {
        assert!(load_private_catalog(Path::new("relative.json")).is_err());
        assert!(load_private_catalog(Path::new("/tmp/missing-catalog.json")).is_err());
    }
}
