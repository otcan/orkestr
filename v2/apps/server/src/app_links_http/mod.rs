//! The owner's tools and apps (`docs/v2/app-links.md`): links to web apps the
//! host runs beside Orkestr, such as the credential store's own UI or an ops
//! dashboard. The web app's Apps page lists them next to the published sites
//! (ORK-834), so a new one shows without a release of the app.
//!
//! The server only reads a value-free list the operator keeps (`catalog`):
//! `<ORKESTR_V2_HOME>/app-links.json`, or the file named by
//! `ORKESTR_V2_APP_LINKS`, resolved once at startup and read on each request,
//! so an edit shows without a restart. It never fetches a link. The route
//! needs the owner's password-signed-in browser session, like the sites and
//! credentials pages: no other session learns these addresses.
use super::*;
use std::path::{Path, PathBuf};

mod catalog;
#[cfg(test)]
mod tests;

pub(crate) const LINKS_ENV: &str = "ORKESTR_V2_APP_LINKS";

/// Where the links file is read, and the last refusal logged (each refusal is
/// logged once, not on every page load).
#[derive(Clone, Default)]
pub(crate) struct AppLinks {
    path: Option<Arc<PathBuf>>,
    logged: Arc<std::sync::Mutex<Option<&'static str>>>,
}

impl AppLinks {
    pub(crate) fn at(path: PathBuf) -> Self {
        AppLinks {
            path: Some(Arc::new(path)),
            logged: Arc::default(),
        }
    }

    fn load(&self) -> catalog::Listing {
        let Some(path) = self.path.as_deref() else {
            return catalog::Listing::default();
        };
        let listing = catalog::load(path);
        let mut logged = self.logged.lock().unwrap_or_else(|e| e.into_inner());
        if *logged != listing.error {
            if let Some(code) = listing.error {
                eprintln!("app links: list refused ({code}); the apps page lists none");
            }
            *logged = listing.error;
        }
        listing
    }

    #[cfg(test)]
    fn logged(&self) -> Option<&'static str> {
        *self.logged.lock().unwrap()
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/app-links", get(list))
}

impl AppState {
    /// Trusted startup only: the file named by `ORKESTR_V2_APP_LINKS`, or
    /// `<home>/app-links.json`. A missing file lists no links.
    pub fn with_app_links(mut self, home: &Path) -> Self {
        let path = std::env::var_os(LINKS_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("app-links.json"));
        self.app_links = AppLinks::at(path);
        self
    }
    #[cfg(test)]
    pub(crate) fn with_links(mut self, links: AppLinks) -> Self {
        self.app_links = links;
        self
    }
}

/// `{configured, error?, links: [...]}` in the file's order. A refused or
/// malformed file is an empty list with a fixed `error` code, never a 500.
async fn list(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    browser::password_session(&state, &headers).await?;
    let links = state.app_links.clone();
    let listing = tokio::task::spawn_blocking(move || links.load())
        .await
        .unwrap_or_else(|_| catalog::Listing::refused("unreadable"));
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(listing)).into_response())
}
