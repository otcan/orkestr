//! Sidebar presentation: activity grouping of sub-chats, relative times and
//! live activity labels. Pure functions over the server's observation; a
//! row never admits work.
use orkestr_v2_contracts::{SidebarActivity, SidebarEntry, SidebarPage};
use std::collections::{BTreeMap, BTreeSet};

/// One visible row: an entry, its nesting depth and its group summary.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub entry: SidebarEntry,
    pub depth: usize,
    /// Direct and nested sub-chats under this entry.
    pub descendants: usize,
    /// Newest activity of this entry or any sub-chat (the group's sort key).
    pub group_activity_ms: Option<i64>,
    /// Unread replies in collapsed sub-chats, shown on the parent.
    pub hidden_unread: u32,
    /// A collapsed sub-chat is working.
    pub hidden_activity: bool,
    pub expanded: bool,
}

pub fn valid(page: &SidebarPage) -> bool {
    page.is_valid()
}

/// Entries the list shows: hidden system chats only when `show_hidden`, but
/// always the open one (a hidden chat opened by its URL stays selectable).
pub fn shown(entries: &[SidebarEntry], show_hidden: bool, selected: &str) -> Vec<SidebarEntry> {
    entries
        .iter()
        .filter(|e| show_hidden || !e.hidden || e.key == selected)
        .cloned()
        .collect()
}

struct Node<'a> {
    entry: &'a SidebarEntry,
    children: Vec<usize>,
    newest: Option<i64>,
    unread: u32,
    active: bool,
    count: usize,
}

/// Groups sub-chats under their parent. Parents sort by the newest activity
/// in their group; sub-chats sort newest first. A parent is expanded when
/// listed in `expanded` or when it contains `selected`.
pub fn rows(entries: &[SidebarEntry], expanded: &BTreeSet<String>, selected: &str) -> Vec<Row> {
    let index: BTreeMap<&str, usize> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| (e.key.as_str(), i))
        .collect();
    let mut nodes: Vec<Node> = entries
        .iter()
        .map(|entry| Node {
            entry,
            children: Vec::new(),
            newest: entry.last_activity_ms,
            unread: entry.unread,
            active: entry.activity.active(),
            count: 0,
        })
        .collect();
    // A parent link that would form a cycle is ignored (the child becomes a root).
    let parent_of = |i: usize| -> Option<usize> {
        let parent = *index.get(entries[i].parent_key.as_deref()?)?;
        let mut seen = BTreeSet::from([i]);
        let mut current = parent;
        loop {
            if !seen.insert(current) {
                return None;
            }
            match entries[current]
                .parent_key
                .as_deref()
                .and_then(|p| index.get(p))
            {
                Some(next) => current = *next,
                None => return Some(parent),
            }
        }
    };
    let parents: Vec<Option<usize>> = (0..entries.len()).map(parent_of).collect();
    for (child, parent) in parents.iter().enumerate() {
        if let Some(parent) = parent {
            nodes[*parent].children.push(child);
        }
    }
    // Aggregate bottom-up (children before parents by depth).
    let depth = |mut i: usize| {
        let mut d = 0;
        while let Some(p) = parents[i] {
            d += 1;
            i = p;
        }
        d
    };
    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by_key(|i| std::cmp::Reverse(depth(*i)));
    for i in order {
        let children = nodes[i].children.clone();
        for c in children {
            let (newest, unread, active, count) = (
                nodes[c].newest,
                nodes[c].unread,
                nodes[c].active,
                nodes[c].count,
            );
            let node = &mut nodes[i];
            node.newest = node.newest.max(newest);
            node.unread = node.unread.saturating_add(unread);
            node.active |= active;
            node.count += 1 + count;
        }
    }
    let sort = |list: &mut Vec<usize>, nodes: &[Node]| {
        list.sort_by(|a, b| {
            nodes[*b]
                .newest
                .cmp(&nodes[*a].newest)
                .then_with(|| {
                    nodes[*a]
                        .entry
                        .name
                        .to_lowercase()
                        .cmp(&nodes[*b].entry.name.to_lowercase())
                })
                .then_with(|| nodes[*a].entry.key.cmp(&nodes[*b].entry.key))
        })
    };
    for i in 0..nodes.len() {
        let mut children = std::mem::take(&mut nodes[i].children);
        sort(&mut children, &nodes);
        nodes[i].children = children;
    }
    let contains_selected = |i: usize| {
        let mut stack = nodes[i].children.clone();
        while let Some(c) = stack.pop() {
            if nodes[c].entry.key == selected {
                return true;
            }
            stack.extend(nodes[c].children.iter().copied());
        }
        false
    };
    let mut roots: Vec<usize> = (0..entries.len())
        .filter(|i| parents[*i].is_none())
        .collect();
    sort(&mut roots, &nodes);
    let mut out = Vec::with_capacity(entries.len());
    let mut stack: Vec<(usize, usize)> = roots.into_iter().rev().map(|i| (i, 0)).collect();
    while let Some((i, d)) = stack.pop() {
        let node = &nodes[i];
        let open = !node.children.is_empty()
            && (expanded.contains(&node.entry.key) || contains_selected(i));
        out.push(Row {
            entry: node.entry.clone(),
            depth: d,
            descendants: node.count,
            group_activity_ms: node.newest,
            hidden_unread: if open {
                0
            } else {
                node.unread - node.entry.unread
            },
            hidden_activity: !open && node.active && !node.entry.activity.active(),
            expanded: open,
        });
        if open {
            for c in node.children.iter().rev() {
                stack.push((*c, d + 1));
            }
        }
    }
    out
}

/// `typing…` while a Fast reply is produced, `thinking…` for Deep or Worker work.
pub fn activity_label(activity: &SidebarActivity) -> Option<String> {
    if activity.fast {
        Some("typing…".into())
    } else if activity.deep && activity.workers > 0 {
        Some(format!(
            "thinking… · {} worker{}",
            activity.workers,
            if activity.workers == 1 { "" } else { "s" }
        ))
    } else if activity.deep {
        Some("thinking…".into())
    } else if activity.workers > 0 {
        Some(format!(
            "{} worker{} thinking…",
            activity.workers,
            if activity.workers == 1 { "" } else { "s" }
        ))
    } else {
        None
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Civil date (UTC) of a Unix millisecond time.
fn civil(ms: i64) -> (i64, usize, i64) {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, (month - 1) as usize, day)
}

/// Compact relative time: `now`, `5m`, `3h`, `2d`, then `12 Oct` (`12 Oct 2025`).
pub fn relative_time(now_ms: i64, at_ms: Option<i64>) -> String {
    let Some(at) = at_ms else {
        return String::new();
    };
    let ago = (now_ms - at).max(0) / 1000;
    match ago {
        0..60 => "now".into(),
        60..3_600 => format!("{}m", ago / 60),
        3_600..86_400 => format!("{}h", ago / 3_600),
        86_400..604_800 => format!("{}d", ago / 86_400),
        _ => {
            let (year, month, day) = civil(at);
            if civil(now_ms).0 == year {
                format!("{day} {}", MONTHS[month])
            } else {
                format!("{day} {} {year}", MONTHS[month])
            }
        }
    }
}

/// Unread badge text; large counts are capped.
pub fn unread_label(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=99 => Some(count.to_string()),
        _ => Some("99+".into()),
    }
}
