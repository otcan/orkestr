//! Unregistered attachment HTTP projection helpers.
//!
//! Core owns persisted bytes, manifests and authenticated storage ports.
//! No router is exposed until those exact ports and DTOs are published.
mod authority;
mod download;
#[cfg(test)]
mod tests;
