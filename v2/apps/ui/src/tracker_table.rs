//! Tracker table logic (pure): filters, search, sorting, labels and the
//! request bodies the table view sends. The view only renders this.
use orkestr_v2_contracts::{tracker_iso_utc, TrackerRow, TrackerStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    /// Applied and not closed (default).
    Open,
    /// Saved leads (job alerts, saved jobs).
    Leads,
    /// Needs a human look.
    Review,
    /// Rejected, withdrawn, no response.
    Closed,
    Archived,
    All,
}

impl Filter {
    pub const ALL: [Filter; 6] = [
        Filter::Open,
        Filter::Leads,
        Filter::Review,
        Filter::Closed,
        Filter::Archived,
        Filter::All,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Filter::Open => "Open",
            Filter::Leads => "Leads",
            Filter::Review => "Needs review",
            Filter::Closed => "Closed",
            Filter::Archived => "Archived",
            Filter::All => "All",
        }
    }
    pub fn keeps(self, row: &TrackerRow) -> bool {
        let closed = row.status.is_terminal() || row.status == TrackerStatus::NoResponse;
        match self {
            Filter::Archived => row.archived,
            _ if row.archived => false,
            Filter::Open => !closed && row.status != TrackerStatus::Saved,
            Filter::Leads => row.status == TrackerStatus::Saved,
            Filter::Review => row.needs_review,
            Filter::Closed => closed,
            Filter::All => true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Column {
    Company,
    Role,
    Status,
    Source,
    Applied,
    LastContact,
    NextStep,
}

impl Column {
    pub const ALL: [Column; 7] = [
        Column::Company,
        Column::Role,
        Column::Status,
        Column::Source,
        Column::Applied,
        Column::LastContact,
        Column::NextStep,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Column::Company => "Company",
            Column::Role => "Role",
            Column::Status => "Status",
            Column::Source => "Source",
            Column::Applied => "Applied",
            Column::LastContact => "Last contact",
            Column::NextStep => "Next step",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sort {
    pub column: Column,
    pub descending: bool,
}

impl Default for Sort {
    fn default() -> Self {
        Self {
            column: Column::LastContact,
            descending: true,
        }
    }
}

impl Sort {
    /// Clicking a header sorts by it; clicking it again reverses.
    pub fn toggle(self, column: Column) -> Self {
        if self.column == column {
            Self {
                column,
                descending: !self.descending,
            }
        } else {
            Self {
                column,
                descending: matches!(column, Column::Applied | Column::LastContact),
            }
        }
    }
}

fn status_rank(status: TrackerStatus) -> u8 {
    match status.rank() {
        Some(rank) => rank + 2,
        None => u8::from(status == TrackerStatus::Withdrawn),
    }
}

/// Rows the table shows, in order.
pub fn visible<'a>(
    rows: &'a [TrackerRow],
    filter: Filter,
    query: &str,
    sort: Sort,
) -> Vec<&'a TrackerRow> {
    let query = query.trim().to_lowercase();
    let mut out: Vec<&TrackerRow> = rows
        .iter()
        .filter(|r| filter.keeps(r))
        .filter(|r| {
            query.is_empty()
                || [&r.company, &r.role, &r.source, &r.notes]
                    .iter()
                    .any(|v| v.to_lowercase().contains(&query))
                || r.next_step
                    .as_deref()
                    .is_some_and(|v| v.to_lowercase().contains(&query))
        })
        .collect();
    out.sort_by(|a, b| {
        let order = match sort.column {
            Column::Company => a.company.to_lowercase().cmp(&b.company.to_lowercase()),
            Column::Role => a.role.to_lowercase().cmp(&b.role.to_lowercase()),
            Column::Status => status_rank(a.status).cmp(&status_rank(b.status)),
            Column::Source => a.source.cmp(&b.source),
            Column::Applied => a.applied_ms.cmp(&b.applied_ms),
            Column::LastContact => a.last_contact_ms.cmp(&b.last_contact_ms),
            Column::NextStep => a.next_step.cmp(&b.next_step),
        };
        let order = if sort.descending {
            order.reverse()
        } else {
            order
        };
        order.then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// Counts for the filter chips.
pub fn count(rows: &[TrackerRow], filter: Filter) -> usize {
    rows.iter().filter(|r| filter.keeps(r)).count()
}

/// `2026-10-20` (UTC) for the table cells.
pub fn day(ms: i64) -> String {
    tracker_iso_utc(ms)[..10].to_owned()
}
