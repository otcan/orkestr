//! Compile the independently owned scheduler before factory registration.
//! Module tests cover private policy and owned scratch; executable HTTP coverage
//! lives in worker_execution_http.py and requires the ordinary factory hook.
#[path = "../src/control_dispatch.rs"]
#[allow(dead_code)]
mod control_dispatch;
#[path = "../src/stop_execution/mod.rs"]
#[allow(dead_code)]
mod stop_execution;
#[path = "../src/worker_execution/mod.rs"]
#[allow(dead_code)]
mod worker_execution;
