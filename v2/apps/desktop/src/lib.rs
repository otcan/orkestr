//! Platform-neutral parts of the Orkestr desktop app, kept free of GUI types
//! so they are unit-tested without a display: first-run configuration, the
//! server supervisor and the on-demand Claude Code installer.
pub mod claude;
pub mod local;
pub mod supervisor;
