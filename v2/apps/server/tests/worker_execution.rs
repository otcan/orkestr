//! Compile the independently owned scheduler before factory registration.
//! Module tests cover private policy and owned scratch; executable HTTP coverage
//! lives in worker_execution_http.py and requires the ordinary factory hook.
#[path = "../src/control_dispatch.rs"]
#[allow(dead_code)]
mod control_dispatch;
#[path = "../src/control_registry.rs"]
#[allow(dead_code)]
mod control_registry;
#[path = "../src/offline_python/mod.rs"]
#[allow(dead_code)]
mod offline_python;
#[path = "../src/owned_children.rs"]
#[allow(dead_code)]
mod owned_children;
#[path = "../src/stop_execution/mod.rs"]
#[allow(dead_code)]
mod stop_execution;
// Compile the trusted scheduler availability port without HTTP route wiring.
#[path = "../src/worker_execution/mod.rs"]
#[allow(dead_code)]
mod worker_execution;
#[path = "../src/worker_tasks/access.rs"]
#[allow(dead_code)]
mod worker_tasks;
