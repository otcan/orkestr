use orkestr_v2_server::{router, AppState};
use orkestr_v2_store_sqlite::Store;
use std::path::PathBuf;
mod bind_config;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home =
        PathBuf::from(std::env::var("ORKESTR_V2_HOME").map_err(|_| "ORKESTR_V2_HOME is required")?);
    if !home.is_absolute() {
        return Err("ORKESTR_V2_HOME must be absolute".into());
    }
    std::fs::create_dir_all(&home)?;
    let home = home.canonicalize()?;
    if let Ok(legacy) = std::env::var("ORKESTR_HOME") {
        let legacy = PathBuf::from(legacy).canonicalize()?;
        if home.starts_with(&legacy) || legacy.starts_with(&home) {
            return Err("v2 home overlaps legacy home".into());
        }
    }
    let config = bind_config::BindConfig::parse(
        std::env::var("ORKESTR_V2_BIND").ok().as_deref(),
        std::env::var("ORKESTR_V2_CONTAINER_BIND").ok().as_deref(),
        std::env::var("ORKESTR_V2_ORIGIN").ok().as_deref(),
    )?;
    let bind = config.bind;
    let token = std::env::var("ORKESTR_V2_BOOTSTRAP_TOKEN")
        .map_err(|_| "ORKESTR_V2_BOOTSTRAP_TOKEN is required")?;
    let store = Store::open(&home.join("core.sqlite3"))
        .await
        .map_err(|_| "store startup failed")?;
    let origin = config.origin;
    let state = AppState::new(store, token, origin)?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    eprintln!(
        "orkestr-v2-server schema=1 home={} bind={} execution=disabled connections=none",
        home.display(),
        listener.local_addr()?
    );
    let mut app = router(state);
    if let Some(dist) = std::env::var_os("ORKESTR_V2_UI_DIST") {
        app = orkestr_v2_server::with_static_ui(app, &PathBuf::from(dist))?;
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
