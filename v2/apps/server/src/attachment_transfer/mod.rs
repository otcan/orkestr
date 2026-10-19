//! Unregistered attachment HTTP projection helpers.
//!
//! Core owns persisted bytes, manifests and authenticated storage ports.
//! Coordinator owns canonical registration and browser guard mounting.
mod authority;
mod download;
mod list;
mod routes;
pub(crate) use routes::router;
#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
mod http_tests;
