//! Coordinator mounts this policy-only router under the canonical browser guard.
//! No route, ingress, producer, reservation, delivery or manual-send endpoint.
mod routes;
pub(crate) use routes::router;
#[cfg(all(test, unix))]
mod tests;
