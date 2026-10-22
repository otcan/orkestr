# Orkestr desktop app

A Tauri v2 shell for people who never open a terminal. It runs the bundled
Orkestr V2 server on this computer, shows the V2 web UI in a native window and
stays in the tray.

What it does on first launch, without any input:

- creates its folder in the platform app-data directory
  (`~/.local/share/de.orkestr.desktop` on Linux,
  `~/Library/Application Support/de.orkestr.desktop` on macOS,
  `%APPDATA%\de.orkestr.desktop` on Windows) with `desktop.json` (the port),
  `bootstrap.token` (owner-only file) and the server data in `home/`;
- picks a random free port on `127.0.0.1` and keeps it while it stays free;
- starts the server with only `ORKESTR_V2_HOME`, `ORKESTR_V2_BIND`,
  `ORKESTR_V2_BOOTSTRAP_TOKEN` and `ORKESTR_V2_UI_DIST` set (inherited
  `ORKESTR*` variables are dropped), restarts it after a crash with backoff,
  and stops it on quit (Linux also uses `PR_SET_PDEATHSIG`);
- while no owner exists (`GET /api/v2/setup`), hands the setup token to the
  UI page through a webview initialization script, so the first screen is
  "Create your account": a local username and password, no Keycloak, no
  operator token. Passkeys follow ORK-609.

Tray menu: Open Orkestr, Start at login (autostart plugin, launches with
`--minimized`), Install Claude Code… (runs Anthropic's official installer from
claude.ai only after a confirmation), Sign in to Claude Code… (opens
`claude` in a terminal window for Anthropic's own `/login`), Check for
updates…, Open log folder, Quit. Navigation away from the local origin opens
in the user's browser, so Google, LinkedIn and ChatGPT sign-ins never happen
inside the webview. The webview gets no Tauri IPC permissions.

## Build

The crate is its own Cargo workspace (own `Cargo.lock`), so Tauri, GTK and
WebKit never enter the server workspace. Linux needs
`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf`.

```sh
# from v2/: server + UI bundle + verified Codex CLI, staged as sidecars
python3 packaging/desktop/build_bundle.py --out /tmp/orkestr-bundle --desktop
# then, in this directory, with the pinned CLI (@tauri-apps/cli 2.12.4)
tauri build --bundles deb,appimage          # Linux
tauri build --bundles app,dmg               # macOS
python3 tests/smoke_linux.py --deb <path-to.deb>   # headless first-run smoke test
```

`build_bundle.py` also writes a reproducible
`orkestr-v2-<version>-<target>.tar.gz` (server, `ui/`, `manifest.json` with
SHA-256 of every file) for non-desktop installs. The Codex CLI comes from the
official OpenAI release pinned in `packaging/desktop/codex-pins.json`
(Apache-2.0); a size or SHA-256 mismatch fails the build. Claude Code is never
bundled.

## Signed releases (owner action needed)

CI (`.github/workflows/v2-desktop.yml`) builds unsigned artifacts only and
never reads a secret. A signed release needs these, held by the owner and
never committed:

| Secret | Used for |
| --- | --- |
| Updater key pair (`tauri signer generate`): `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Signs update bundles. Put its public key into `plugins.updater.pubkey` at release time (`tauri build --config '{"plugins":{"updater":{"pubkey":"…"}},"bundle":{"createUpdaterArtifacts":true}}'`). The key committed in `tauri.conf.json` is a throwaway development key whose private half was deleted; it can verify nothing real. |
| Apple Developer ID Application certificate (`.p12`): `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Signs the app and both sidecars (Gatekeeper) |
| Notarization: `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`, or an App Store Connect API key | Notarizes the dmg |
| Windows code signing: Azure Trusted Signing account, or an EV/OV certificate | Authenticode for the NSIS installer and sidecars (SmartScreen) |

The release job must be a separate, trusted workflow (push or tag on a
protected ref, an environment with required reviewers). The repository's
workflow policy (`scripts/security/workflow-policy.mjs`) rejects any secret in
the current workflows, so adding it is a reviewed policy change. It then
publishes the signed installers and `latest.json` to the `desktop-stable`
release that `plugins.updater.endpoints` points at.

## Known gaps

- **Windows:** the V2 server does not build for Windows yet (Unix process
  and sandbox APIs). CI keeps the Windows shell compiling and verifies the
  pinned Windows Codex download; the NSIS installer waits for the server port.
- **Model execution:** the desktop server starts with execution disabled.
  Running Codex or Claude turns uses the beta execution configuration, which
  needs the Python provider broker and Linux sandboxing; packaging that for
  macOS and Windows is follow-up work. The Codex sidecar path is passed as
  `ORKESTR_V2_CODEX_BIN` for that step.
- **Chrome and Thunderbird** (ORK-605) are not managed yet.
