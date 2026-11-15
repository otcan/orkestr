//! The owner's sites (ORK-834, `docs/v2/sites.md`): static microsites and
//! apps the host serves at `https://<slug>.<sites domain>/`, listed so a chat
//! can link the site it published and one page can list them all.
//!
//! The server only reads a value-free catalog the host's publishing tool
//! writes (`catalog`): `<ORKESTR_V2_HOME>/sites-catalog.json`, or the file
//! named by `ORKESTR_V2_SITES_CATALOG`, resolved once at startup and read on
//! each request (it changes only when something is published). It never
//! fetches a site. The route needs the owner's password-signed-in browser
//! session, like the credentials page.
use super::*;
use std::path::{Path, PathBuf};

mod catalog;
#[cfg(test)]
mod tests;

pub(crate) const CATALOG_ENV: &str = "ORKESTR_V2_SITES_CATALOG";

/// Where the catalog is read, and the last refusal logged (each refusal is
/// logged once, not on every page load).
#[derive(Clone, Default)]
pub(crate) struct SitesCatalog {
    path: Option<Arc<PathBuf>>,
    logged: Arc<std::sync::Mutex<Option<&'static str>>>,
}

impl SitesCatalog {
    pub(crate) fn at(path: PathBuf) -> Self {
        SitesCatalog {
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
                eprintln!("sites: catalog refused ({code}); the sites page lists none");
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
    Router::new().route("/api/v2/sites", get(list))
}

impl AppState {
    /// Trusted startup only: the file named by `ORKESTR_V2_SITES_CATALOG`,
    /// or `<home>/sites-catalog.json`. A missing file lists no sites.
    pub fn with_sites_catalog(mut self, home: &Path) -> Self {
        let path = std::env::var_os(CATALOG_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("sites-catalog.json"));
        self.sites = SitesCatalog::at(path);
        self
    }
    #[cfg(test)]
    pub(crate) fn with_sites(mut self, sites: SitesCatalog) -> Self {
        self.sites = sites;
        self
    }
}

/// `{configured, error?, sites: [...]}`, newest publish first. A refused or
/// malformed file is an empty list with a fixed `error` code, never a 500.
async fn list(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    browser::password_session(&state, &headers).await?;
    let sites = state.sites.clone();
    let listing = tokio::task::spawn_blocking(move || sites.load())
        .await
        .unwrap_or_else(|_| catalog::Listing::refused("unreadable"));
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(listing)).into_response())
}
