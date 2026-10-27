//! Read-only memory accounting of one owned child's process tree, for host
//! admission estimates only. Nothing here is authority, and no PID leaves.
use std::collections::HashSet;

/// Bound on processes walked in one tree.
const MAX_TREE: usize = 512;

/// Sum of the peak resident set (`VmHWM`) of `root` and its live
/// descendants, in bytes. `None` when the root cannot be read.
pub(super) fn tree_peak_rss_bytes(root: u32) -> Option<u64> {
    let mut seen = HashSet::new();
    let mut pending = vec![root];
    let mut total = 0u64;
    let mut root_read = false;
    while let Some(pid) = pending.pop() {
        if seen.len() >= MAX_TREE || !seen.insert(pid) {
            continue;
        }
        let Some(peak) = peak_rss_bytes(pid) else {
            continue;
        };
        root_read |= pid == root;
        total = total.saturating_add(peak);
        pending.extend(children(pid));
    }
    root_read.then_some(total)
}

fn peak_rss_bytes(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let kib = status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        // Kernel threads and zombies have no VmHWM: they cost nothing here.
        .map_or(Some(0), |value| {
            value.split_whitespace().next()?.parse::<u64>().ok()
        })?;
    kib.checked_mul(1024)
}

fn children(pid: u32) -> Vec<u32> {
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return Vec::new();
    };
    tasks
        .flatten()
        .filter_map(|task| std::fs::read_to_string(task.path().join("children")).ok())
        .flat_map(|list| {
            list.split_whitespace()
                .filter_map(|child| child.parse::<u32>().ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn own_process_tree_has_a_peak() {
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let own = super::tree_peak_rss_bytes(std::process::id()).unwrap();
        let alone = super::peak_rss_bytes(std::process::id()).unwrap();
        assert!(alone > 0);
        // The tree includes the live child's peak.
        assert!(own > alone);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(super::tree_peak_rss_bytes(u32::MAX), None);
    }
}
