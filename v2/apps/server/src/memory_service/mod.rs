//! Browser-only explicit Memory operations. Coordinator owns canonical mounting.
mod routes;
mod security;
mod wire;
#[allow(dead_code)] // Unmounted until coordinator integration.
pub(crate) fn router(state: crate::AppState) -> axum::Router<crate::AppState> {
    routes::router(state)
}
#[cfg(test)]
mod tests;
