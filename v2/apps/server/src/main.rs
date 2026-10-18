use orkestr_v2_server::{owned_execution::ConfiguredExecution, router, AppState};
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
    let mut state = AppState::new(store.clone(), token, origin)?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let execution = match std::env::var_os("ORKESTR_V2_EXECUTION_CONFIG") {
        None => None,
        Some(file) => {
            let execution =
                ConfiguredExecution::load(&store, &home, bind, &PathBuf::from(file)).await?;
            state = execution.install_control(state);
            Some(execution)
        }
    };
    eprintln!(
        "orkestr-v2-server schema=1 home={} bind={} execution={} connections=none",
        home.display(),
        listener.local_addr()?,
        if execution.is_some() {
            "isolated-acceptance"
        } else {
            "disabled"
        }
    );
    let mut app = router(state);
    if let Some(dist) = std::env::var_os("ORKESTR_V2_UI_DIST") {
        app = orkestr_v2_server::with_static_ui(app, &PathBuf::from(dist))?;
    }
    let execution = execution.map(ConfiguredExecution::start);
    let (shutdown, mut requested) = tokio::sync::watch::channel(false);
    let mut serving = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = requested.changed().await;
            })
            .await
    });
    let completed = tokio::select! {
        result = &mut serving => Some(result),
        _ = tokio::signal::ctrl_c() => None,
    };
    // An open SSE connection must not delay the owned execution fence/cleanup.
    // Stop accepting HTTP and stop the supervisor before waiting for HTTP drain.
    let _ = shutdown.send(true);
    if let Some(execution) = execution {
        execution.shutdown().await;
    }
    if let Some(result) = completed {
        result??;
    } else {
        match tokio::time::timeout(std::time::Duration::from_secs(2), &mut serving).await {
            Ok(result) => result??,
            Err(_) => {
                serving.abort();
                let _ = serving.await;
            }
        }
    }
    Ok(())
}
