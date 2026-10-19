//! Test-only external observation. Namespace PIDs are never host signal targets.
use std::{
    collections::{HashSet, VecDeque},
    os::unix::fs::MetadataExt,
    path::Path,
};

#[derive(Clone, Copy)]
pub(super) struct HostIdentity {
    pid: u32,
    start: u64,
}

fn start(pid: u32) -> Option<u64> {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()?
        .rsplit_once(") ")?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

impl HostIdentity {
    pub(super) fn observe(program: &Path, namespace: u64, started: u64) -> Self {
        use std::os::unix::ffi::OsStrExt;
        let mut pending = VecDeque::from([(std::process::id(), 0)]);
        let mut seen = HashSet::new();
        let mut found = Vec::new();
        while let Some((pid, depth)) = pending.pop_front() {
            if !seen.insert(pid) {
                continue;
            }
            // The unit-test harness owns several concurrently running fixtures.
            assert!(
                seen.len() <= 2048 && depth <= 12,
                "owned test process tree exceeded bound"
            );
            if let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) {
                for task in tasks.flatten() {
                    if let Ok(children) = std::fs::read_to_string(task.path().join("children")) {
                        pending.extend(
                            children
                                .split_whitespace()
                                .filter_map(|id| id.parse().ok())
                                .map(|id| (id, depth + 1)),
                        );
                    }
                }
            }
            let Ok(argv) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
                continue;
            };
            if !argv
                .split(|byte| *byte == 0)
                .take(2)
                .any(|arg| arg == program.as_os_str().as_bytes())
            {
                continue;
            }
            if start(pid) == Some(started)
                && std::fs::metadata(format!("/proc/{pid}/ns/pid"))
                    .is_ok_and(|info| info.ino() == namespace)
            {
                found.push(Self {
                    pid,
                    start: started,
                });
            }
        }
        assert_eq!(
            found.len(),
            1,
            "exact synthetic native host identity required"
        );
        found[0]
    }

    pub(super) fn gone(self) -> bool {
        start(self.pid) != Some(self.start)
    }
}
