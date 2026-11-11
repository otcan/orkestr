use dioxus::prelude::*;
use orkestr_v2_ui::{composer_attachments::size, upload_progress::UploadProgress};
/// The upload bar. While a file is still transferring or being prepared it
/// offers Cancel, which `oncancel` receives with that file's upload id.
#[component]
pub fn UploadProgressView(
    value: UploadProgress,
    oncancel: Option<EventHandler<String>>,
) -> Element {
    let completed = size(value.completed_bytes);
    let total = size(value.total_bytes);
    let label = value.label();
    let percent = value.percent();
    let cancel = oncancel.zip(value.cancellable().map(str::to_owned));
    rsx! {
        div {class:"upload-progress", "aria-label":"File upload progress",
            p {class:"upload-progress-stage", role:"status", "{label} · {value.file_name} · file {value.file_index} of {value.file_count}"}
            if let Some((oncancel, id)) = cancel {
                button {r#type:"button", class:"upload-control", "aria-label":"Cancel upload of {value.file_name}",
                    onclick: move |_| oncancel.call(id.clone()), "Cancel"}
            }
            progress {max:"100",value:"{percent}","aria-label":"Upload progress", "aria-valuetext":"{completed} of {total} transferred",}
            span {class:"upload-progress-bytes", "{percent}% · {completed} / {total} transferred"}
        }
    }
}
