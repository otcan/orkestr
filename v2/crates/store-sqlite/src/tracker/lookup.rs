//! Scoped row matching through immutable merged-key aliases.
use super::{row_of, Result, ROW_COLUMNS, UNKNOWN_COMPANY};
use crate::conversation_resources::unavailable;
use orkestr_v2_contracts::*;
use sqlx::{Sqlite, Transaction};

async fn load(
    tx: &mut Transaction<'_, Sqlite>,
    sql: &str,
    binds: &[&str],
) -> Result<Vec<TrackerRow>> {
    let mut query = sqlx::query(sql);
    for value in binds {
        query = query.bind(*value);
    }
    let rows = query.fetch_all(&mut **tx).await.map_err(unavailable)?;
    rows.iter().map(row_of).collect()
}

/// Find the row this event belongs to; `true` when the match is ambiguous.
pub(super) async fn find(
    tx: &mut Transaction<'_, Sqlite>,
    scope: (&str, &str),
    event: &TrackerEventInput,
    link: Option<&str>,
) -> Result<Option<(TrackerRow, bool)>> {
    let (owner, conversation) = scope;
    // A reply in a known thread belongs to that row, whatever it says.
    for reference in &event.thread_refs {
        let found = load(
            tx,
            &format!("SELECT {ROW_COLUMNS} FROM tracker_rows WHERE NOT EXISTS(SELECT 1 FROM tracker_row_merges m WHERE m.owner_id=tracker_rows.owner_id AND m.conversation_id=tracker_rows.conversation_id AND m.absorb_id=tracker_rows.id) AND id=(SELECT row_id FROM tracker_messages WHERE owner_id=? AND conversation_id=? AND message_ref=?)"),
            &[owner, conversation, reference],
        )
        .await?;
        if let Some(row) = found.into_iter().next() {
            return Ok(Some((row, false)));
        }
    }
    if event.requires_thread {
        return Ok(None);
    }
    if let Some(link) = link {
        let found = load(
            tx,
            &format!("SELECT {ROW_COLUMNS} FROM tracker_rows WHERE NOT EXISTS(SELECT 1 FROM tracker_row_merges m WHERE m.owner_id=tracker_rows.owner_id AND m.conversation_id=tracker_rows.conversation_id AND m.absorb_id=tracker_rows.id) AND id=(SELECT row_id FROM tracker_row_links WHERE owner_id=? AND conversation_id=? AND link=?)"),
            &[owner, conversation, link],
        )
        .await?;
        if let Some(row) = found.into_iter().next() {
            return Ok(Some((row, false)));
        }
    }
    let company = tracker_company_key(&event.company);
    if company.is_empty() || event.company == UNKNOWN_COMPANY {
        return Ok(None);
    }
    let role = event
        .role
        .as_deref()
        .map(tracker_role_key)
        .unwrap_or_default();
    if !role.is_empty() {
        let exact = aliases(tx, scope, &company, Some(&role)).await?;
        let ambiguous = exact.len() > 1;
        if let Some(row) = exact.into_iter().next() {
            return Ok(Some((row, ambiguous)));
        }
        if event.kind == TrackerEventKind::JobAlert {
            return Ok(None);
        }
    }
    // Same company (one key may extend the other: "acme" / "acme-robotics").
    let candidates = aliases(tx, scope, &company, None).await?;
    if !role.is_empty() {
        // A role for a row that had none yet ("your application to Acme").
        let open: Vec<TrackerRow> = candidates
            .into_iter()
            .filter(|r| r.role_key.is_empty())
            .collect();
        return Ok((open.len() == 1).then(|| (open.into_iter().next().unwrap(), false)));
    }
    let open: Vec<&TrackerRow> = candidates
        .iter()
        .filter(|r| !r.status.is_terminal())
        .collect();
    Ok(match open.len() {
        1 => Some((open[0].clone(), false)),
        0 => candidates.into_iter().next().map(|r| (r, false)),
        _ => Some((open[0].clone(), true)),
    })
}

/// Retained absorbed keys are aliases, including through multi-hop merges.
async fn aliases(
    tx: &mut Transaction<'_, Sqlite>,
    scope: (&str, &str),
    company: &str,
    role: Option<&str>,
) -> Result<Vec<TrackerRow>> {
    let predicate = if role.is_some() {
        "company_key=?3 AND role_key=?4"
    } else {
        // Compare literal word prefixes; legacy keys cannot inject LIKE patterns.
        "(company_key=?3 OR substr(company_key,1,length(?3)+1)=?3 || '-' OR substr(?3,1,length(company_key)+1)=company_key || '-')"
    };
    let active = if role.is_some() { "" } else { "AND archived=0" };
    let sql = format!("WITH RECURSIVE resolved(id) AS (
        SELECT id FROM tracker_rows WHERE owner_id=?1 AND conversation_id=?2 AND {predicate}
        UNION SELECT m.keep_id FROM tracker_row_merges m JOIN resolved r ON m.absorb_id=r.id WHERE m.owner_id=?1 AND m.conversation_id=?2)
        SELECT {ROW_COLUMNS} FROM tracker_rows WHERE owner_id=?1 AND conversation_id=?2 AND id IN(SELECT id FROM resolved)
        AND NOT EXISTS(SELECT 1 FROM tracker_row_merges m WHERE m.owner_id=tracker_rows.owner_id AND m.conversation_id=tracker_rows.conversation_id AND m.absorb_id=tracker_rows.id)
        {active} ORDER BY last_contact_ms DESC,id");
    let mut binds = vec![scope.0, scope.1, company];
    if let Some(role) = role {
        binds.push(role);
    }
    load(tx, &sql, &binds).await
}
