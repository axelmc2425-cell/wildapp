//! Windows-only enforcement helpers and service layer. Compiled only with `cfg(windows)`.
//! Everything here is type-checked on Linux (`--target x86_64-pc-windows-gnu`) but can only
//! be run on Windows. Pure decisions live in `crate::service_logic`.

pub mod dns;
pub mod install;
pub mod paths;
pub mod pipe;
pub mod platform;
pub mod procs;
pub mod scm;
pub mod service;
