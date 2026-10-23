//! Read-only job-mail ingress from a desktop mail client's local store
//! (ORK-605 lead path: Thunderbird signed in with its own Google OAuth; this
//! crate only reads the Maildir/mbox files Thunderbird already wrote).
//!
//! - [`profile`]: Thunderbird profile discovery per OS and inbox folders.
//! - [`store`]: bounded incremental Maildir/mbox scanning with a cursor.
//! - [`envelope`]: MIME parsing into the normalised envelope.
//! - [`rules`] + [`classify`]: the recipe's rule pack turns envelopes into
//!   tracker events (LinkedIn, ATS, assessments, interviews, rejections).
//!
//! No network, no credentials, no writes to the mail store; the profile's
//! password, key and cookie stores are never opened.
pub mod classify;
pub mod date;
pub mod envelope;
pub mod mime;
pub mod profile;
pub mod rules;
pub mod store;
pub mod template;
#[cfg(test)]
mod testdir;

pub use classify::{classify, Outcome};
pub use envelope::Envelope;
pub use rules::RulePack;
pub use store::{
    scan, scan_folders, Cursor, MailFolder, ScanFolder, ScanLimits, ScanOutput, ScanStats,
};
