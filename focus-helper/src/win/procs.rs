//! Process table backed by `sysinfo`. Windows only.
//!
//! Limitation: sysinfo may report names without `.exe` or truncated (long names). Callers
//! must compare through `decide::normalize_app`; a truncated name can fail to match a block
//! entry, which errs on the side of not killing.
use crate::enforce::{Proc, ProcessTable};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use std::sync::Mutex;

pub struct SysinfoTable {
    sys: Mutex<System>,
}

impl SysinfoTable {
    pub fn new() -> Self {
        SysinfoTable { sys: Mutex::new(System::new()) }
    }
}

impl Default for SysinfoTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessTable for SysinfoTable {
    fn list(&self) -> Vec<Proc> {
        let mut sys = self.sys.lock().unwrap_or_else(|e| e.into_inner());
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        sys.processes()
            .iter()
            .map(|(pid, p)| Proc { pid: pid.as_u32(), name: p.name().to_string_lossy().into_owned() })
            .collect()
    }

    fn kill(&self, pid: u32) -> bool {
        let sys = self.sys.lock().unwrap_or_else(|e| e.into_inner());
        sys.process(Pid::from_u32(pid)).map_or(false, |p| p.kill())
    }
}
