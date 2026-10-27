//! Read-only memory accounting of one owned child's process tree, for host
//! admission estimates only. Nothing here is authority, and no PID leaves.
use std::collections::HashSet;

/// Bound on processes walked in one tree.
const MAX_TREE: usize = 512;

/// Sum of the peak resident set (`VmHWM`) of `root` and its live
/// descendants, in bytes. `None` when the root cannot be read.
pub(super) fn tree_peak_rss_bytes(root: u32) -> Option<u64> {
    let mut seen = HashSet::new();
    let mut pending = vec![(root, None)];
    let mut total = 0u64;
    let mut root_read = false;
    while let Some((pid, parent)) = pending.pop() {
        if seen.len() >= MAX_TREE || !seen.insert(pid) {
            continue;
        }
        let Some(status) = status(pid) else {
            continue;
        };
        // A listed child that exited and whose PID was reused before this
        // read names another process: count it (and its tree) only while it
        // is still the child of the process that listed it.
        if parent.is_some() && parent_pid(&status) != parent {
            continue;
        }
        let Some(peak) = peak_rss_in(&status) else {
            continue;
        };
        root_read |= pid == root;
        total = total.saturating_add(peak);
        pending.extend(children(pid).into_iter().map(|child| (child, Some(pid))));
    }
    root_read.then_some(total)
}

fn status(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/status")).ok()
}

fn parent_pid(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:"))?
        .trim()
        .parse()
        .ok()
}

#[cfg(test)]
fn peak_rss_bytes(pid: u32) -> Option<u64> {
    peak_rss_in(&status(pid)?)
}

fn peak_rss_in(status: &str) -> Option<u64> {
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
        // VmHWM never shrinks, so the root alone, read first, is a lower
        // bound of the root's share of the later tree reading.
        let alone = super::peak_rss_bytes(std::process::id()).unwrap();
        let own = super::tree_peak_rss_bytes(std::process::id()).unwrap();
        assert!(alone > 0);
        // The tree includes the live child's peak.
        assert!(own > alone);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(super::tree_peak_rss_bytes(u32::MAX), None);
    }
}
