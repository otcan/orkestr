//! One atomic snapshot transaction; transport failures never publish partial pages.
use crate::Projection;
use orkestr_v2_contracts::ConversationSnapshot;
use std::future::Future;

pub async fn reconcile<E, F, Fut>(
    id: &str,
    after: i64,
    original: &Projection,
    required_watermark: i64,
    mut fetch: F,
) -> Result<Projection, E>
where
    E: From<String>,
    F: FnMut(i64) -> Fut,
    Fut: Future<Output = Result<ConversationSnapshot, E>>,
{
    if after < 0 || after != original.watermark || required_watermark < after {
        return Err("Applied cursor/projection mismatch".to_string().into());
    }
    let mut staged = original.clone();
    let mut cursor = after;
    let mut initial = None;
    let mut previous_watermark = after;
    for _ in 0..1000 {
        let page = fetch(cursor).await?;
        if page.conversation_id.to_string() != id
            || page.last_sequence < previous_watermark
            || page.last_sequence < cursor
            || page
                .messages
                .iter()
                .any(|message| message.sequence <= cursor)
            || page.next_cursor.is_some_and(|next| {
                next <= cursor
                    || next > page.last_sequence
                    || page.messages.last().map(|message| message.sequence) != Some(next)
            })
        {
            return Err("Invalid or backwards snapshot cursor/watermark"
                .to_string()
                .into());
        }
        let watermark = *initial.get_or_insert(page.last_sequence);
        previous_watermark = page.last_sequence;
        let next = page.next_cursor;
        staged
            .page(page)
            .map_err(|error| E::from(error.to_string()))?;
        match next {
            Some(next) => cursor = next,
            None => {
                if watermark < required_watermark {
                    return Err("Snapshot has not reached journal event; resync required"
                        .to_string()
                        .into());
                }
                staged.watermark = watermark;
                return Ok(staged);
            }
        }
    }
    Err("Snapshot scan limit exceeded; retry snapshot"
        .to_string()
        .into())
}
