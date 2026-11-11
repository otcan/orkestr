//! Orkestr settings (`#settings`, ORK-789): what belongs to the owner account
//! and to this server rather than to one chat. It opens from the global header
//! like the other owner-wide views; a chat's model, replies, provider handoff
//! and desktops stay in that chat's own settings.
use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;

#[component]
pub fn OrkestrSettings(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    rsx! {
        div { class: "orkestr-settings",
            p { class: "settings-scope-intro", "These settings belong to your account and this Orkestr server, not to one chat. A chat's model, replies and desktops are under More → Chat settings in that chat." }
            section { class: "settings-scope-section", "aria-label": "Account settings",
                h2 { "Your account" }
                p { class: "settings-scope", "Applies to your owner account in every chat." }
                crate::owner_password_view::OwnerPassword { csrf: csrf.clone(), session_scope, onexpired }
                crate::vault_view::Vault { csrf: csrf.clone(), session_scope, onexpired }
            }
            // Its own heading says the sign-in is shared by the whole server.
            crate::provider_sign_in_view::ProviderSignInSection { csrf, session_scope, onexpired }
            crate::beta_settings::BetaSettings {}
        }
    }
}
