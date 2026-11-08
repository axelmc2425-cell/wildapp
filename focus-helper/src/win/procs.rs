//! Process table: listing via `sysinfo`, termination via `TerminateProcess`. Windows only.
//!
//! Name limitation: sysinfo on Windows reports the full ImageName, so truncation is not
//! expected, but the name may lack `.exe`; always compare through `decide::normalize_app`.
//! If a name were ever truncated or wrong, block-list matching would simply miss it, but in
//! frozen/allow-list mode a name that fails to match the allow or critical lists is killed.
//! `enforce_once` therefore skips empty/placeholder names (`is_killable_name`), and `kill`
//! re-verifies identity below.
//!
//! PID reuse: between `list()` and `kill()` a PID can be recycled by another process, which
//! might be a critical one that `enforce_once` never saw. So `kill` opens the process, reads
//! its current image path, and terminates only if the normalized name equals the name that
//! was listed for that pid and is not in CRITICAL_APPS. Any doubt returns false.
use crate::decide::{normalize_app, CRITICAL_APPS};
use crate::enforce::{Proc, ProcessTable};
use std::collections::HashMap;
use std::sync::Mutex;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

pub struct SysinfoTable {
    sys: Mutex<System>,
    /// pid -> normalized name as of the last `list()`.
    listed: Mutex<HashMap<u32, String>>,
}

impl SysinfoTable {
    pub fn new() -> Self {
        SysinfoTable { sys: Mutex::new(System::new()), listed: Mutex::new(HashMap::new()) }
    }
}

impl Default for SysinfoTable {
    fn default() -> Self {
        Self::new()
    }
}

/// Current image path of `pid`'s process, only if it can be opened for termination.
/// Returns the open handle too so the same handle is used for the kill (no second race).
fn open_with_name(pid: u32) -> Option<(isize, String)> {
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h == 0 {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) == 0 {
            CloseHandle(h);
            return None;
        }
        Some((h, String::from_utf16_lossy(&buf[..len as usize])))
    }
}

impl ProcessTable for SysinfoTable {
    fn list(&self) -> Vec<Proc> {
        let procs: Vec<Proc> = {
            let mut sys = self.sys.lock().unwrap_or_else(|e| e.into_inner());
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );
            sys.processes()
                .iter()
                .map(|(pid, p)| Proc {
                    pid: pid.as_u32(),
                    name: p.name().to_string_lossy().into_owned(),
                })
                .collect()
        };
        let mut listed = self.listed.lock().unwrap_or_else(|e| e.into_inner());
        listed.clear();
        listed.extend(procs.iter().map(|p| (p.pid, normalize_app(&p.name))));
        procs
    }

    fn kill(&self, pid: u32) -> bool {
        let expected = {
            let listed = self.listed.lock().unwrap_or_else(|e| e.into_inner());
            match listed.get(&pid) {
                Some(n) => n.clone(),
                None => return false,
            }
        };
        let Some((h, path)) = open_with_name(pid) else {
            return false;
        };
        let actual = normalize_app(&path);
        let ok = actual == expected && !CRITICAL_APPS.iter().any(|c| normalize_app(c) == actual);
        let done = ok && unsafe { TerminateProcess(h, 1) } != 0;
        unsafe { CloseHandle(h) };
        done
    }
}
