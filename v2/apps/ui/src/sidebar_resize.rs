use dioxus::prelude::*;

/// The conversation list's resize handle (ORK-786): a focusable window
/// splitter between the list and the conversation. Dragging and the arrow
/// keys run in `sidebar_resize.mjs`, within fixed bounds; the width is
/// remembered per viewer. Hidden while the list is collapsed or a drawer.
#[component]
pub fn SidebarResize() -> Element {
    use_effect(|| {
        let source = include_str!("sidebar_resize.mjs").replace("export ", "");
        let script = format!(
            "{source}\nfor (let i = 0; i < 200; i++) {{ const handle = document.querySelector('.sidebar-resize'); const workspace = handle?.closest('.workspace'); if (workspace) {{ installResize(handle, workspace); break; }} await new Promise(r => setTimeout(r, 25)); }}\nreturn null;"
        );
        spawn(async move {
            let _ = document::eval(&script).await;
        });
    });
    rsx! {
        div { class: "sidebar-resize", role: "separator", tabindex: "0",
            "aria-orientation": "vertical", "aria-controls": "conversation-sidebar",
            "aria-label": "Resize conversation list",
            title: "Drag or use the arrow keys to resize. Double-click resets."
        }
    }
}
