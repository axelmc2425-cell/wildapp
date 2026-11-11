//! `Platform` implementation backed by the Windows enforcement helpers, plus the OS RNG.

use std::io;

use crate::daemon::Platform;
use crate::enforce::ProcessTable;
use crate::usage::Sample;
use crate::win::{dns, foreground};
use crate::win::procs::SysinfoTable;
use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

pub struct WindowsPlatform {
    procs: SysinfoTable,
}

impl WindowsPlatform {
    pub fn new() -> Self {
        WindowsPlatform { procs: SysinfoTable::new() }
    }
}

impl Default for WindowsPlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl Platform for WindowsPlatform {
    fn enforce_hosts(&mut self, sites: &[String]) -> io::Result<bool> {
        dns::enforce_hosts(sites)
    }
    fn set_doh_off(&mut self) -> io::Result<Vec<String>> {
        dns::set_doh_off()
    }
    fn clear_doh_off(&mut self) -> io::Result<()> {
        dns::clear_doh_off()
    }
    fn flush_dns(&mut self) -> io::Result<()> {
        dns::flush_dns()
    }
    fn process_table(&self) -> &dyn ProcessTable {
        &self.procs
    }
    fn foreground(&mut self) -> Option<Sample> {
        foreground::sample()
    }
    fn usage_tracking(&self) -> bool {
        true
    }
}

/// 16 bytes from the OS cryptographic RNG (`BCryptGenRandom`, system-preferred RNG).
pub fn os_nonce() -> io::Result<[u8; 16]> {
    let mut buf = [0u8; 16];
    // SAFETY: `buf` is a valid writable buffer of the stated length; a null algorithm handle is
    // required with BCRYPT_USE_SYSTEM_PREFERRED_RNG.
    let status = unsafe {
        BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG)
    };
    if status == 0 {
        Ok(buf)
    } else {
        Err(io::Error::other(format!("BCryptGenRandom failed: NTSTATUS {status:#x}")))
    }
}
