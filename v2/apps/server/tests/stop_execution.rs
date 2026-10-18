//! Compile the separately owned factory adapter without changing main/lib wiring.
//! Behavioral ordinary-Store/native-I/O coverage lives in Runtime session tests;
//! the owning factory adds HTTP scheduling coverage when registering this module.
#[path = "../src/stop_execution/mod.rs"]
#[allow(dead_code)]
mod stop_execution;
