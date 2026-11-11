use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;

/// Owner and installation controls deliberately mount outside conversation settings.
#[component]
pub fn OrkestrSettings(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    rsx! {
        section { "aria-label": "Orkestr settings",
            h2 { "Orkestr settings" }
            p { "Shared settings for your account and this Orkestr installation. They are independent of the selected chat." }
            section { "aria-label": "Account settings",
                h3 { "Your account" }
                p { "Your password and vault belong to your owner account across chats." }
                crate::owner_password_view::OwnerPassword { key: "password-{session_scope.read().generation()}", csrf: csrf.clone(), session_scope, onexpired }
                crate::vault_view::Vault { key: "vault-{session_scope.read().generation()}", csrf: csrf.clone(), session_scope, onexpired }
            }
            section { "aria-label": "Installation provider settings",
                h3 { "Shared provider connections" }
                p { "Signing a provider in or out affects this entire server, including other chats using that connection." }
                crate::provider_sign_in_view::ProviderSignInSection { key: "provider-sign-in-{session_scope.read().generation()}", csrf, session_scope, onexpired }
            }
            crate::beta_settings::BetaSettings {}
        }
    }
}
