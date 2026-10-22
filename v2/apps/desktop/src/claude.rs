//! Claude Code, installed on demand with Anthropic's own installer.
//!
//! Orkestr does not redistribute Claude Code. After an explicit click and a
//! confirmation, the app runs the official installer from claude.ai unchanged.
//! The user signs in through Claude Code's own flow; Orkestr never reads,
//! stores or forwards Claude credentials.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const INSTALL_SH: &str = "https://claude.ai/install.sh";
pub const INSTALL_PS1: &str = "https://claude.ai/install.ps1";

pub const CONSENT: &str = "Orkestr will download and run Anthropic's official Claude Code \
installer from claude.ai. Claude Code is Anthropic software under Anthropic's terms. \
You sign in with your own Claude account in Claude Code's own window; Orkestr never \
sees your Claude password or tokens.";

fn executable() -> &'static str {
    if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    }
}

/// Where the official installer puts the launcher (`~/.local/bin`).
pub fn default_location(user_home: &Path) -> PathBuf {
    user_home.join(".local").join("bin").join(executable())
}

/// An installed `claude`, from the installer location or `PATH`.
pub fn installed(user_home: Option<&Path>, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = user_home {
        candidates.push(default_location(home));
    }
    if let Some(path) = path {
        candidates.extend(std::env::split_paths(path).map(|dir| dir.join(executable())));
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// The unmodified official installer, run without a console window.
pub fn installer_command() -> Command {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("$ErrorActionPreference='Stop'; irm {INSTALL_PS1} | iex"),
        ]);
        command
    } else {
        let mut command = Command::new("/bin/bash");
        command.args([
            "-c",
            &format!("set -euo pipefail; curl -fsSL {INSTALL_SH} | bash"),
        ]);
        command
    };
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// Opens Claude Code in a terminal window so the user signs in with
/// Anthropic's own flow (`/login`).
pub fn sign_in_command(claude: &Path) -> Option<Command> {
    let claude = claude.to_string_lossy().into_owned();
    if cfg!(target_os = "macos") {
        let quoted = claude.replace('\\', "\\\\").replace('"', "\\\"");
        let mut command = Command::new("osascript");
        command.args([
            "-e",
            &format!("tell application \"Terminal\" to do script \"'{quoted}'\""),
            "-e",
            "tell application \"Terminal\" to activate",
        ]);
        Some(command)
    } else if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.args(["/C", "start", "Claude Code", &claude]);
        Some(command)
    } else {
        let terminals: [(&str, &[&str]); 4] = [
            ("x-terminal-emulator", &["-e"]),
            ("gnome-terminal", &["--"]),
            ("konsole", &["-e"]),
            ("xterm", &["-e"]),
        ];
        let path = std::env::var_os("PATH")?;
        terminals.iter().find_map(|(name, args)| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(name))
                .find(|candidate| candidate.is_file())
                .map(|terminal| {
                    let mut command = Command::new(terminal);
                    command.args(*args).arg(&claude);
                    command
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_runs_the_official_script_unmodified() {
        let command = installer_command();
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let script = args.last().unwrap();
        if cfg!(windows) {
            assert!(script.ends_with("irm https://claude.ai/install.ps1 | iex"));
        } else {
            assert_eq!(command.get_program(), "/bin/bash");
            assert!(script.ends_with("curl -fsSL https://claude.ai/install.sh | bash"));
        }
    }

    #[test]
    fn detection_prefers_the_installer_location_then_path() {
        let root = std::env::temp_dir().join(format!("orkestr-claude-{}", std::process::id()));
        let home = root.join("home");
        let other = root.join("bin");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(installed(Some(&home), Some(other.as_os_str())), None);
        std::fs::write(other.join(executable()), "").unwrap();
        assert_eq!(
            installed(Some(&home), Some(other.as_os_str())),
            Some(other.join(executable()))
        );
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        std::fs::write(default_location(&home), "").unwrap();
        assert_eq!(
            installed(Some(&home), Some(other.as_os_str())),
            Some(default_location(&home))
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
