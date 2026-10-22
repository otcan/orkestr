//! Conversation posts (migration 0065): assistant-side messages from outside a
//! run. Writing one records a row and nothing else: no message, event, input,
//! wake, steer or execution. The delivery adapter lists pending rows and marks
//! each delivered once its own ledger holds it.
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use crate::Store;
use orkestr_v2_contracts::{
    valid_post_key, valid_post_label, valid_post_text, valid_post_token, ConversationId,
    ConversationPost, ConversationPostAuthor, ConversationPostRequest, CONVERSATION_POST_PAGE_MAX,
};
use sqlx::{sqlite::SqliteRow, Row};
use uuid::Uuid;

type Result<T> = std::result::Result<T, ResourceError>;

/// Which posts a listing returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostListing {
    /// Not yet delivered, oldest first (the delivery adapter).
    Pending,
    /// Created strictly after this time, oldest first.
    After(i64),
    /// The newest ones, returned oldest first (the chat view).
    Latest,
}

/// Whether a write created the post or found the identical earlier one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostReceipt {
    pub post: ConversationPost,
    pub created: bool,
}

const COLUMNS: &str = "id,conversation_id,request_key,author,label,provider,model,text,after_sequence,created_ms,delivered_ms";

fn post(row: &SqliteRow) -> Result<ConversationPost> {
    let uuid = |name: &str| {
        row.try_get::<String, _>(name)
            .ok()
            .and_then(|v| Uuid::parse_str(&v).ok())
            .ok_or(ResourceError::Unavailable)
    };
    let value = ConversationPost {
        id: uuid("id")?,
        conversation_id: ConversationId(uuid("conversation_id")?),
        request_key: row.try_get("request_key").map_err(unavailable)?,
        author: ConversationPostAuthor::parse(row.try_get("author").map_err(unavailable)?)
            .ok_or(ResourceError::Unavailable)?,
        label: row.try_get("label").map_err(unavailable)?,
        provider: row.try_get("provider").map_err(unavailable)?,
        model: row.try_get("model").map_err(unavailable)?,
        text: row.try_get("text").map_err(unavailable)?,
        after_sequence: row.try_get("after_sequence").map_err(unavailable)?,
        created_ms: row.try_get("created_ms").map_err(unavailable)?,
        delivered_ms: row.try_get("delivered_ms").map_err(unavailable)?,
    };
    value
        .is_valid()
        .then_some(value)
        .ok_or(ResourceError::Unavailable)
}

/// Validate and normalize a request (default label by author).
pub fn normalized(request: &ConversationPostRequest) -> Result<ConversationPostRequest> {
    let label = request
        .label
        .clone()
        .unwrap_or_else(|| request.author.default_label().to_owned());
    let valid = valid_post_key(&request.request_key)
        && valid_post_label(&label)
        && valid_post_text(&request.text)
        && request.provider.as_deref().is_none_or(valid_post_token)
        && request.model.as_deref().is_none_or(valid_post_token);
    if !valid {
        return Err(ResourceError::Invalid);
    }
    Ok(ConversationPostRequest {
        label: Some(label),
        ..request.clone()
    })
}

fn same(existing: &ConversationPost, request: &ConversationPostRequest) -> bool {
    existing.author == request.author
        && Some(&existing.label) == request.label.as_ref()
        && existing.text == request.text
        && existing.provider == request.provider
        && existing.model == request.model
}

impl Store {
    /// Record a post, or return the identical earlier one for the same
    /// `request_key`. A different body under the same key is
    /// `conversation_post_conflict`; a conversation whose WhatsApp chat was
    /// archived is `conversation_archived`.
    pub async fn create_conversation_post(
        &self,
        credential: &str,
        owner: &orkestr_v2_contracts::OwnerId,
        conversation: &ConversationId,
        request: &ConversationPostRequest,
    ) -> Result<PostReceipt> {
        let request = normalized(request)?;
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let existing = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM conversation_posts WHERE owner_id=? AND conversation_id=? AND request_key=?"
        ))
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(&request.request_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if let Some(row) = existing {
            let existing = post(&row)?;
            tx.commit().await.map_err(unavailable)?;
            return if same(&existing, &request) {
                Ok(PostReceipt {
                    post: existing,
                    created: false,
                })
            } else {
                Err(ResourceError::Conflict("conversation_post_conflict"))
            };
        }
        let archived: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM whatsapp_chat_provisions WHERE owner_id=? AND conversation_id=? AND archived=1",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if archived != 0 {
            return Err(ResourceError::Conflict("conversation_archived"));
        }
        let after_sequence: i64 =
            sqlx::query_scalar("SELECT sequence FROM conversations WHERE id=? AND owner_id=?")
                .bind(conversation.to_string())
                .bind(owner.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        let value = ConversationPost {
            id: Uuid::new_v4(),
            conversation_id: conversation.clone(),
            request_key: request.request_key.clone(),
            author: request.author,
            label: request.label.clone().unwrap_or_default(),
            provider: request.provider.clone(),
            model: request.model.clone(),
            text: request.text.clone(),
            after_sequence,
            created_ms: now_ms().max(1),
            delivered_ms: None,
        };
        sqlx::query(&format!(
            "INSERT INTO conversation_posts(owner_id,{COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)"
        ))
        .bind(owner.to_string())
        .bind(value.id.to_string())
        .bind(conversation.to_string())
        .bind(&value.request_key)
        .bind(value.author.as_str())
        .bind(&value.label)
        .bind(&value.provider)
        .bind(&value.model)
        .bind(&value.text)
        .bind(value.after_sequence)
        .bind(value.created_ms)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(PostReceipt {
            post: value,
            created: true,
        })
    }

    pub async fn conversation_posts(
        &self,
        credential: &str,
        owner: &orkestr_v2_contracts::OwnerId,
        conversation: &ConversationId,
        listing: PostListing,
        limit: u16,
    ) -> Result<Vec<ConversationPost>> {
        if !(1..=CONVERSATION_POST_PAGE_MAX).contains(&limit) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let base = format!(
            "SELECT rowid AS row_order,{COLUMNS} FROM conversation_posts WHERE owner_id=? AND conversation_id=?"
        );
        let query = match listing {
            PostListing::Pending => {
                format!("{base} AND delivered_ms IS NULL ORDER BY created_ms,rowid LIMIT ?")
            }
            PostListing::After(_) => {
                format!("{base} AND created_ms>? ORDER BY created_ms,rowid LIMIT ?")
            }
            PostListing::Latest => format!(
                "SELECT * FROM ({base} ORDER BY created_ms DESC,rowid DESC LIMIT ?) ORDER BY created_ms,row_order"
            ),
        };
        let mut query = sqlx::query(&query)
            .bind(owner.to_string())
            .bind(conversation.to_string());
        if let PostListing::After(after) = listing {
            query = query.bind(after);
        }
        let rows = query
            .bind(i64::from(limit))
            .fetch_all(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        rows.iter().map(post).collect()
    }

    /// Mark a post as taken over by the delivery adapter. Replays keep the
    /// first time and return the same post.
    pub async fn deliver_conversation_post(
        &self,
        credential: &str,
        owner: &orkestr_v2_contracts::OwnerId,
        conversation: &ConversationId,
        id: Uuid,
    ) -> Result<ConversationPost> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let changed = sqlx::query("UPDATE conversation_posts SET delivered_ms=COALESCE(delivered_ms,?) WHERE owner_id=? AND conversation_id=? AND id=?")
            .bind(now_ms().max(1))
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?
            .rows_affected();
        if changed != 1 {
            return Err(ResourceError::NotFound);
        }
        let row = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM conversation_posts WHERE id=?"
        ))
        .bind(id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        let value = post(&row)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }
}

#[cfg(test)]
#[path = "conversation_posts_tests.rs"]
mod tests;
