//! Orkestr desktop app: starts the bundled local server, shows its web UI in
//! a native window and lives in the tray. No terminal, no environment
//! variables: first run generates everything in the platform app-data folder.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use orkestr_desktop::{claude, local::Local, supervisor};
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const MAIN: &str = "main";
const SPLASH: &str = "splash";
/// Passed by the autostart entry: start in the tray without a window.
const MINIMIZED: &str = "--minimized";

struct Desktop {
    local: Local,
    supervisor: Mutex<Option<supervisor::Supervisor>>,
    log_dir: std::path::PathBuf,
}

fn main() {
    let minimized = std::env::args().any(|arg| arg == MINIMIZED);
    let app = tauri::Builder::default()
        // Must be first: a second launch only brings the running app forward.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let log_dir = app.path().app_log_dir()?;
            let mut local = Local::prepare(&data_dir)?;
            local.ensure_port()?;
            let spec = supervisor::ServerSpec {
                program: supervisor::sidecar("orkestr-v2-server")?,
                home: local.home.clone(),
                port: local.port,
                token: local.token.clone(),
                ui_dist: app.path().resource_dir()?.join("ui"),
                log_dir: log_dir.clone(),
                codex: supervisor::sidecar("codex").ok().filter(|p| p.is_file()),
            };
            build_tray(&handle)?;
            if !minimized {
                WebviewWindowBuilder::new(app, SPLASH, WebviewUrl::App("index.html".into()))
                    .title("Orkestr")
                    .inner_size(420.0, 280.0)
                    .resizable(false)
                    .center()
                    .build()?;
            }
            let events = handle.clone();
            let started = supervisor::Supervisor::start(spec, move |event| {
                server_event(&events, event, minimized)
            });
            app.manage(Desktop {
                local,
                supervisor: Mutex::new(Some(started)),
                log_dir,
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window keeps Orkestr running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Orkestr could not start");
    app.run(|app, event| match event {
        // Keep running in the tray when no window is open; Quit passes a code.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => stop_server(app),
        _ => {}
    });
}

fn stop_server(app: &AppHandle) {
    if let Some(desktop) = app.try_state::<Desktop>() {
        if let Some(running) = desktop.supervisor.lock().unwrap().take() {
            running.shutdown();
        }
    }
}

fn server_event(app: &AppHandle, event: supervisor::Event, minimized: bool) {
    match event {
        supervisor::Event::Ready { first } => {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if first || app2.get_webview_window(MAIN).is_none() {
                    if let Err(error) = open_main(&app2, !minimized) {
                        fail(
                            &app2,
                            &format!("The Orkestr window could not open: {error}"),
                        );
                    }
                } else if let Some(window) = app2.get_webview_window(MAIN) {
                    let _ = window.reload();
                }
            });
        }
        supervisor::Event::Restarting(reason) => {
            eprintln!("orkestr-desktop: restarting server: {reason}")
        }
        supervisor::Event::Failed(reason) => fail(
            app,
            &format!(
                "Orkestr's local server keeps stopping ({reason}). Quit and open Orkestr again; \
             if it still fails, the log folder (tray menu → Open log folder) shows why."
            ),
        ),
    }
}

fn fail(app: &AppHandle, message: &str) {
    eprintln!("orkestr-desktop: {message}");
    app.dialog()
        .message(message)
        .title("Orkestr")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/// The main window on the local server. While no owner exists, the page
/// receives the one-time setup token through an initialization script for
/// exactly this origin (never through a URL).
fn open_main(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    let desktop = app.state::<Desktop>();
    let origin = desktop.local.origin();
    let url: Url = format!("{origin}/").parse().expect("loopback URL");
    let setup =
        supervisor::setup_required(desktop.local.port, &desktop.local.token).unwrap_or(false);
    let script = if setup {
        format!(
            "if (location.origin === {origin:?}) {{ window.__ORKESTR_LOCAL_SETUP__ = {{ bootstrap: {token:?} }}; }}",
            token = desktop.local.token
        )
    } else {
        String::new()
    };
    let allowed = origin.clone();
    let opener = app.clone();
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("Orkestr")
        .inner_size(1200.0, 820.0)
        .min_inner_size(400.0, 560.0)
        .visible(visible)
        .initialization_script(script)
        .on_navigation(move |target| {
            if target.origin().ascii_serialization() == allowed {
                return true;
            }
            // Sign-in pages (ChatGPT, Google, LinkedIn) open in the user's browser.
            if matches!(target.scheme(), "http" | "https") {
                let _ = opener.opener().open_url(target.as_str(), None::<&str>);
            }
            false
        })
        .build()?;
    if let Some(splash) = app.get_webview_window(SPLASH) {
        let _ = splash.close();
    }
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else if let Some(splash) = app.get_webview_window(SPLASH) {
        let _ = splash.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let open = MenuItem::with_id(app, "open", "Open Orkestr", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        autostart,
        None::<&str>,
    )?;
    let claude_install = MenuItem::with_id(
        app,
        "claude-install",
        "Install Claude Code…",
        true,
        None::<&str>,
    )?;
    let claude_login = MenuItem::with_id(
        app,
        "claude-login",
        "Sign in to Claude Code…",
        true,
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, "update", "Check for updates…", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open log folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Orkestr", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &separator,
            &login,
            &claude_install,
            &claude_login,
            &update,
            &logs,
            &separator2,
            &quit,
        ],
    )?;
    let login = Arc::new(login);
    let mut tray = TrayIconBuilder::with_id("orkestr")
        .tooltip("Orkestr")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "autostart" => toggle_autostart(app, &login),
            "claude-install" => install_claude(app),
            "claude-login" => sign_in_claude(app),
            "update" => check_update(app),
            "logs" => {
                if let Some(desktop) = app.try_state::<Desktop>() {
                    let _ = app
                        .opener()
                        .open_path(desktop.log_dir.to_string_lossy(), None::<&str>);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn toggle_autostart(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);
    let result = if enabled {
        manager.disable()
    } else {
        manager.enable()
    };
    if let Err(error) = result {
        fail(
            app,
            &format!("Start at login could not be changed: {error}"),
        );
    }
    let _ = item.set_checked(manager.is_enabled().unwrap_or(false));
}

fn user_home(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().home_dir().ok()
}

fn install_claude(app: &AppHandle) {
    if let Some(existing) = claude::installed(
        user_home(app).as_deref(),
        std::env::var_os("PATH").as_deref(),
    ) {
        app.dialog()
            .message(format!(
                "Claude Code is already installed ({}).",
                existing.display()
            ))
            .title("Claude Code")
            .show(|_| {});
        return;
    }
    let app = app.clone();
    app.clone()
        .dialog()
        .message(claude::CONSENT)
        .title("Install Claude Code")
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Cancel".into()))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            std::thread::spawn(move || {
                let log = app.state::<Desktop>().log_dir.join("claude-install.log");
                let output = claude::installer_command().output();
                let (ok, detail) = match output {
                    Ok(output) => {
                        let mut text = output.stdout;
                        text.extend_from_slice(&output.stderr);
                        let _ = std::fs::write(&log, &text);
                        (output.status.success(), format!("{}", log.display()))
                    }
                    Err(error) => (false, error.to_string()),
                };
                let message = if ok {
                    "Claude Code is installed. Choose “Sign in to Claude Code…” in the Orkestr menu to sign in with your Claude account.".to_string()
                } else {
                    format!("The Claude Code installer did not finish. Details: {detail}")
                };
                app.dialog()
                    .message(message)
                    .title("Claude Code")
                    .kind(if ok { MessageDialogKind::Info } else { MessageDialogKind::Error })
                    .show(|_| {});
            });
        });
}

fn sign_in_claude(app: &AppHandle) {
    let Some(path) = claude::installed(
        user_home(app).as_deref(),
        std::env::var_os("PATH").as_deref(),
    ) else {
        install_claude(app);
        return;
    };
    match claude::sign_in_command(&path).map(|mut command| command.spawn()) {
        Some(Ok(_)) => {}
        _ => fail(
            app,
            "No terminal window could be opened for the Claude Code sign-in.",
        ),
    }
}

fn check_update(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        };
        match result {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let confirm = app
                    .dialog()
                    .message(format!(
                        "Orkestr {version} is available. Install it and restart now?"
                    ))
                    .title("Update Orkestr")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Update".into(),
                        "Later".into(),
                    ))
                    .blocking_show();
                if confirm {
                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(()) => app.restart(),
                        Err(error) => fail(&app, &format!("The update failed: {error}")),
                    }
                }
            }
            Ok(None) => {
                app.dialog()
                    .message("Orkestr is up to date.")
                    .title("Orkestr")
                    .show(|_| {});
            }
            Err(error) => fail(&app, &format!("Could not check for updates: {error}")),
        }
    });
}
