//! Convert oversized native drafts before entering the idempotent outbox.
use dioxus::prelude::*;
use orkestr_v2_contracts::MessageAttachmentReceipt;
use orkestr_v2_ui::{
    chat_timeline,
    composer_attachments::{self, Attached},
    outbox::{Outbox, Target},
    session_scope::SessionScope,
    Draft,
};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Upload {
    #[serde(default)]
    receipts: Vec<MessageAttachmentReceipt>,
    error: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub fn submit(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut preparing: Signal<bool>,
    mut drafts: Signal<BTreeMap<String, Draft>>,
    mut attached: Signal<Vec<Attached>>,
    outbox: Signal<Outbox>,
    mut status: Signal<String>,
) {
    if preparing() {
        return;
    }
    let typed = drafts
        .peek()
        .get(&conversation)
        .map(|d| d.text.clone())
        .unwrap_or_default();
    let quote = drafts
        .peek()
        .get(&conversation)
        .and_then(|d| d.quote.clone());
    let text = composer_attachments::native_text(&typed, &attached.peek());
    let text = quote
        .as_ref()
        .map(|q| chat_timeline::with_reply_line(&text, q))
        .unwrap_or(text);
    if !orkestr_v2_ui::oversized_message::needs_attachment(&typed, &text) {
        crate::outbox_view::submit(
            Target::Native(conversation),
            drafts,
            attached,
            outbox,
            status,
        );
        return;
    }
    if attached.peek().len() >= 8 || outbox.peek().is_full() {
        status.set("The message needs a text attachment. Remove a file or wait for the outbox before sending.".into());
        return;
    }
    let owner = session_scope.read().generation();
    preparing.set(true);
    status.set("Preparing your full message as an encrypted text attachment…".into());
    spawn(async move {
        let assets = include_str!("asset_base.mjs").replace("export ", "");
        let config = serde_json::json!({"conversation":conversation,"csrf":csrf});
        let expected = serde_json::json!(typed.clone());
        let script = format!("{assets}\nconst element=document.getElementById('composer');if(!element||element.value!=={expected})return {{error:'The draft changed. Send again.'}};try{{const module=await import(uiAssetUrl('encrypted_upload.js'));return await module.nativePaste({config},element,{{retainSuccess:true}});}}catch{{return {{error:'Encrypted text upload interrupted. Send again to resume.'}};}}");
        let result = document::eval(&script).join::<Upload>().await;
        if !session_scope.read().is_current(owner) {
            return;
        }
        preparing.set(false);
        let upload = match result {
            Ok(value) => value,
            Err(_) => {
                status.set("Text attachment could not be prepared. Your message is unchanged; Send again to resume.".into());
                return;
            }
        };
        if let Some(error) = upload.error {
            status.set(error);
            return;
        }
        if upload.receipts.len() != 1 || !upload.receipts[0].is_valid() {
            status.set(
                "Text attachment receipt could not be verified. Your message is unchanged.".into(),
            );
            return;
        }
        // A changed quote/draft must not consume an attachment slot. The JS
        // receipt remains cached for an unchanged-text retry.
        let unchanged = drafts
            .peek()
            .get(&conversation)
            .is_some_and(|d| d.text == typed && d.quote == quote);
        let incoming = upload
            .receipts
            .iter()
            .flat_map(|r| &r.attachments)
            .filter(|file| {
                !attached
                    .peek()
                    .iter()
                    .any(|old| old.summary.attachment_id == file.attachment_id)
            })
            .count();
        match orkestr_v2_ui::oversized_message::commit_state(
            unchanged,
            attached.peek().len(),
            incoming,
        ) {
            orkestr_v2_ui::oversized_message::CommitState::DraftChanged => {
                status.set("The draft or reply changed during upload. Send again to use the prepared text file.".into());
                return;
            }
            orkestr_v2_ui::oversized_message::CommitState::AttachmentLimit => {
                status.set(
                    "The text file is prepared. Remove an attachment before sending again.".into(),
                );
                return;
            }
            orkestr_v2_ui::oversized_message::CommitState::Ready => {}
        }
        // Keep the verified receipt before entering the outbox. Subsequent send
        // failures reuse it instead of re-uploading the original text.
        for receipt in upload.receipts {
            for file in composer_attachments::from_receipt(receipt) {
                if !attached
                    .peek()
                    .iter()
                    .any(|old| old.summary.attachment_id == file.summary.attachment_id)
                {
                    attached.write().push(file);
                }
            }
        }
        let caption = "My full message is in the attached text file. Please read it in full.";
        // The original is now durably attached; keep the short caption even
        // if unusually large notes/context require owner review before Send.
        drafts
            .write()
            .entry(conversation.clone())
            .or_default()
            .edit(caption.into());
        let converted = composer_attachments::native_text(caption, &attached.peek());
        let converted = quote
            .as_ref()
            .map(|q| chat_timeline::with_reply_line(&converted, q))
            .unwrap_or(converted);
        if converted.len() > 32768 {
            status.set("The full message is attached, but its attachment notes and reply context exceed the message limit. Remove the reply or some attachments before sending.".into());
            return;
        }
        crate::outbox_view::submit(
            Target::Native(conversation),
            drafts,
            attached,
            outbox,
            status,
        );
    });
}
