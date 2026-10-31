use orkestr_v2_server::{
    build_identity,
    owned_execution::{ConfiguredExecution, ConfiguredExecutions},
    router_with_google_catalog, AppState,
};
use orkestr_v2_store_sqlite::Store;
use std::path::PathBuf;
mod bind_config;
mod shutdown_signal;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(output) = build_identity::version_output(&arguments)? {
        println!("{output}");
        return Ok(());
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(serve());
    // No detached task or blocking job may delay exit after serve() returns.
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    result
}

/// Deep burst quiet window in ms (default 2500, 0 = off, at most 10000):
/// owner messages split by WhatsApp within this window get one Deep turn.
const DEEP_BURST_QUIET_ENV: &str = "ORKESTR_V2_DEEP_BURST_QUIET_MS";

fn deep_burst_quiet_ms(value: Option<&str>) -> i64 {
    use orkestr_v2_store_sqlite::{DEFAULT_DEEP_BURST_QUIET_MS, MAX_DEEP_BURST_QUIET_MS};
    match value.map(|v| v.trim().parse::<i64>()) {
        None => DEFAULT_DEEP_BURST_QUIET_MS,
        Some(Ok(ms)) if (0..=MAX_DEEP_BURST_QUIET_MS).contains(&ms) => ms,
        Some(_) => {
            // A typo never stops the server: keep the default and say so.
            eprintln!(
                "{DEEP_BURST_QUIET_ENV} must be 0..={MAX_DEEP_BURST_QUIET_MS}; using {DEFAULT_DEEP_BURST_QUIET_MS}"
            );
            DEFAULT_DEEP_BURST_QUIET_MS
        }
    }
}

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
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
        .map_err(|_| "store startup failed")?
        .with_deep_burst_quiet_ms(deep_burst_quiet_ms(
            std::env::var(DEEP_BURST_QUIET_ENV).ok().as_deref(),
        ));
    // Import operator-supplied V1 browser recipients and seal plaintext residue.
    orkestr_v2_server::attachment_keys_http::startup(&store, &home).await;
    let origin = config.origin;
    let mut state = AppState::new(store.clone(), token, origin)?;
    // Operator deploy drain: `<home>/deploy-drain.request` pauses admission.
    let deploy_drain = state.deploy_drain();
    deploy_drain.bind(&home);
    deploy_drain.start();
    let beta = std::env::var_os("ORKESTR_V2_BETA_CONFIG");
    if let Some(path) = &beta {
        // Timers may run beside beta windows: occurrences queue their Deep turn
        // through the same durable window queue as owner input.
        if ["ORKESTR_V2_EXECUTION_CONFIG", "ORKESTR_V2_EXECUTION_SET"]
            .iter()
            .any(|key| std::env::var_os(key).is_some())
        {
            return Err(
                "beta configuration cannot be combined with execution configuration".into(),
            );
        }
        state = state.with_beta_config_file(&PathBuf::from(path), &home)?;
    }
    if let Some(path) =
        std::env::var_os(orkestr_v2_server::owned_execution::PARALLEL_DEEP_QUOTA_FILE_ENV)
    {
        // The Codex quota projection read by the parallel Deep gate; absent,
        // the gate stays closed and no parallel turn starts.
        orkestr_v2_server::owned_execution::set_parallel_deep_quota_file(PathBuf::from(path));
    }
    if let Some(path) = std::env::var_os(orkestr_v2_server::live_map::LIVE_MAP_ENV) {
        // Opt-in: absent means the live map endpoint reports "not configured".
        state = state.with_live_map_file(&PathBuf::from(path))?;
    }
    state = state.with_attachment_export(
        orkestr_v2_server::message_attachments::ExportDir::from_env(&home),
    );
    if let Some(dir) = std::env::var_os(orkestr_v2_server::thread_icons::V1_ICONS_ENV)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        state = state.with_v1_chat_icons(dir);
    }
    if let Some(path) = std::env::var_os("ORKESTR_V2_DESKTOP_BROKER_CONFIG") {
        state = state.with_desktop_broker_file(&PathBuf::from(path))?;
    }
    if let Some(path) = std::env::var_os(orkestr_v2_server::whatsapp_chats::CONFIG_ENV) {
        state = state.with_whatsapp_chats_file(&PathBuf::from(path))?;
    }
    if let Some(path) = std::env::var_os(orkestr_v2_server::restricted_http::CONFIG_ENV) {
        state = state.with_restricted_config_file(&PathBuf::from(path))?;
    }
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let catalog = match std::env::var_os("ORKESTR_V2_GOOGLE_CATALOG") {
        Some(path) => {
            orkestr_v2_server::google_registry_metadata::catalog_config::load_private_catalog(
                &PathBuf::from(path),
            )?
        }
        None => orkestr_v2_server::google_registry_metadata::RegistryCatalog::empty(),
    };
    let execution = match (
        std::env::var_os("ORKESTR_V2_EXECUTION_CONFIG"),
        std::env::var_os("ORKESTR_V2_EXECUTION_SET"),
    ) {
        (None, None) => None,
        (Some(file), None) => {
            let execution =
                ConfiguredExecution::load(&store, &home, bind, &PathBuf::from(file)).await?;
            Some(ConfiguredExecutions::single(execution))
        }
        (None, Some(file)) => {
            Some(ConfiguredExecutions::load_set(&store, &home, bind, &PathBuf::from(file)).await?)
        }
        (Some(_), Some(_)) => return Err("select one execution configuration mode".into()),
    };
    if let Some(execution) = &execution {
        state = execution.install_control(state)?;
    }
    let timer_supervisor = match std::env::var_os("ORKESTR_V2_TIMER_CONFIG") {
        Some(file) => Some(
            orkestr_v2_server::timer_bootstrap::load(&store, &home, &PathBuf::from(file)).await?,
        ),
        None => None,
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
    let beta_state = state.clone();
    let timer_state = state.clone();
    let restricted_state = state.clone();
    let mut app = router_with_google_catalog(state, catalog);
    if let Some(dist) = std::env::var_os("ORKESTR_V2_UI_DIST") {
        app = orkestr_v2_server::with_static_ui(app, &PathBuf::from(dist))?;
    }
    // Host CPU, memory, disk, network and service samples for the metrics panel.
    let host_metrics = orkestr_v2_server::host_metrics::start(&home, deploy_drain.clone());
    // Request ids, per-request logs and metrics for the API and the UI assets.
    let app = orkestr_v2_server::observability::layer(app);
    if let Ok(bind) =
        std::env::var(orkestr_v2_server::observability::metrics_http::METRICS_BIND_ENV)
    {
        // Observability never blocks serving: a bad or busy port is logged.
        match orkestr_v2_server::observability::metrics_http::parse_bind(&bind) {
            Ok(address) => {
                match orkestr_v2_server::observability::metrics_http::spawn(address).await {
                    Ok(bound) => eprintln!("orkestr-v2-server metrics=http://{bound}/metrics"),
                    Err(error) => eprintln!(
                        "orkestr-v2-server metrics=unavailable bind_error={}",
                        error.kind()
                    ),
                }
            }
            Err(reason) => eprintln!("orkestr-v2-server metrics=unavailable reason={reason:?}"),
        }
    }
    let execution = execution.map(ConfiguredExecutions::start);
    let restricted = restricted_state.start_restricted();
    let mut timers = timer_supervisor.map(|supervisor| timer_state.start_timers(supervisor));
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
        _ = shutdown_signal::requested() => None,
        _ = async { match &mut timers { Some(timers) => timers.stopped().await, None => std::future::pending::<()>().await } } => None,
    };
    // An open SSE connection must not delay the owned execution fence/cleanup.
    // Stop accepting HTTP and stop the supervisor before waiting for HTTP drain.
    let _ = shutdown.send(true);
    // Kills a running `du` so the stop never waits for a disk scan.
    host_metrics.shutdown().await;
    if let Some(restricted) = restricted {
        restricted.shutdown().await;
    }
    let beta_cleanup = beta_state.shutdown_beta_window().await;
    let timer_cleanup = match timers {
        Some(timers) => timers.shutdown().await,
        None => Ok(()),
    };
    let tracker_cleanup = timer_state.shutdown_tracker_reads().await;
    let cleanup = match execution {
        Some(execution) => execution.shutdown().await,
        None => Ok(()),
    };
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
    beta_cleanup?;
    timer_cleanup?;
    tracker_cleanup?;
    cleanup?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::deep_burst_quiet_ms;

    #[test]
    fn the_deep_burst_window_defaults_to_two_and_a_half_seconds_and_is_bounded() {
        assert_eq!(deep_burst_quiet_ms(None), 2_500);
        assert_eq!(
            deep_burst_quiet_ms(Some("0")),
            0,
            "0 turns burst waiting off"
        );
        assert_eq!(deep_burst_quiet_ms(Some(" 4000 ")), 4_000);
        for bad in ["-1", "10001", "2.5", "soon", ""] {
            assert_eq!(deep_burst_quiet_ms(Some(bad)), 2_500, "{bad}");
        }
    }
}
