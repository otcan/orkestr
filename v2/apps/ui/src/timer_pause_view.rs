use crate::timer_bridge;
use dioxus::prelude::*;

/// Pause choices: a few presets and an exact date and time. `None` from a
/// resume button is handled by the caller, not here.
#[component]
pub fn PausePicker(label: String, disabled: bool, onpick: EventHandler<i64>) -> Element {
    let mut custom = use_signal(String::new);
    let mut notice = use_signal(String::new);
    let pick = Callback::new(move |name: &'static str| {
        spawn(async move {
            match timer_bridge::preset(name).await {
                Some(ms) => onpick.call(ms),
                None => notice.set("Could not work out that time.".into()),
            }
        });
    });
    rsx! {
        details { class: "pause-picker",
            summary { "{label}" }
            div { class: "pause-presets",
                for (name, text) in [("hour", "1 hour"), ("tomorrow", "Tomorrow 09:00"), ("week", "Next week"), ("forever", "Until I resume")] {
                    button { r#type: "button", disabled, onclick: move |_| pick.call(name), "{text}" }
                }
            }
            div { class: "pause-custom",
                label { r#for: "pause-until-{label}", "Until (your local time)" }
                input { id: "pause-until-{label}", r#type: "datetime-local", value: "{custom}", oninput: move |e| custom.set(e.value()) }
                button { r#type: "button", disabled: disabled || custom().is_empty(), onclick: move |_| {
                    let value = custom();
                    spawn(async move {
                        match timer_bridge::parse_local(&value).await {
                            Some(ms) => onpick.call(ms),
                            None => notice.set("Enter a valid date and time.".into()),
                        }
                    });
                }, "Pause until then" }
            }
            if !notice().is_empty() { p { class: "field-help", role: "status", "{notice}" } }
        }
    }
}
