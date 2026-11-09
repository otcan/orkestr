use dioxus::prelude::*;
use orkestr_v2_ui::{composer_attachments::size, upload_progress::UploadProgress};
#[component]
pub fn UploadProgressView(value: UploadProgress) -> Element {
    let completed = size(value.completed_bytes);
    let total = size(value.total_bytes);
    let label = value.label();
    let percent = value.percent();
    rsx! {
        div {class:"upload-progress", "aria-label":"File upload progress",
            p {class:"upload-progress-stage", role:"status", "{label} · {value.file_name} · file {value.file_index} of {value.file_count}"}
            progress {max:"100",value:"{percent}","aria-label":"Upload progress", "aria-valuetext":"{completed} of {total} transferred",}
            span {class:"upload-progress-bytes", "{percent}% · {completed} / {total} transferred"}
        }
    }
}
