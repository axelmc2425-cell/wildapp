//! Portable daemon logic: owns the lock store and clock, applies decisions to a `Platform`.
//! No Windows code here; the real platform and the service wrapper live in `win`.

use std::io;
use std::path::{Path, PathBuf};

use crate::clock::EffectiveClock;
use crate::decide::decide;
use crate::enforce::{any_window_active, enforce_once, ProcessTable};
use crate::ipc::{self, Request, Response};
use crate::lockstore::LockStore;
use crate::persist;

/// Persist at least this often, in effective-clock milliseconds.
pub const PERSIST_INTERVAL_MS: i64 = 30_000;

pub trait Platform {
    /// Render the managed hosts block for `sites` (empty removes it and unlocks the file).
    fn enforce_hosts(&mut self, sites: &[String]) -> io::Result<bool>;
    /// Turn off DNS-over-HTTPS; returns warnings about browsers that could not be handled.
    fn set_doh_off(&mut self) -> io::Result<Vec<String>>;
    fn clear_doh_off(&mut self) -> io::Result<()>;
    fn flush_dns(&mut self) -> io::Result<()>;
    fn process_table(&self) -> &dyn ProcessTable;
}

pub struct Daemon {
    store: LockStore,
    clock: EffectiveClock,
    state_path: PathBuf,
    last_sites: Option<Vec<String>>,
    doh_on: bool,
    /// Set once DoH has been cleared (or deliberately set) since start. Until then an idle
    /// daemon clears DoH-off unconditionally, to undo state left behind by a crash.
    doh_startup_done: bool,
    doh_warnings: Vec<String>,
    error_warnings: Vec<String>,
    /// High-water mark at the last save; `None` until the first tick anchors it.
    last_saved_ms: Option<i64>,
    /// Set while the latest save failed; cleared by the next successful save.
    persist_error: Option<String>,
}

impl Daemon {
    pub fn load(state_path: &Path) -> Daemon {
        let store = persist::load(state_path);
        let clock = EffectiveClock::new(store.high_water_ms);
        Daemon {
            store,
            clock,
            state_path: state_path.to_path_buf(),
            last_sites: None,
            doh_on: false,
            doh_startup_done: false,
            doh_warnings: Vec::new(),
            error_warnings: Vec::new(),
            last_saved_ms: None,
            persist_error: None,
        }
    }

    pub fn store(&self) -> &LockStore {
        &self.store
    }

    /// DoH warnings followed by the latest platform errors.
    pub fn warnings(&self) -> Vec<String> {
        self.persist_error
            .iter()
            .map(|e| format!("persist: {e}"))
            .chain(self.doh_warnings.iter().cloned())
            .chain(self.error_warnings.iter().cloned())
            .collect()
    }

    /// Returns the error text when the save failed (also remembered in `persist_error`).
    fn save(&mut self) -> Option<String> {
        match persist::save(&self.state_path, &self.store) {
            Ok(()) => {
                self.last_saved_ms = Some(self.store.high_water_ms);
                self.persist_error = None;
                None
            }
            Err(e) => {
                eprintln!("focus-helper: persist failed: {e}");
                let msg = e.to_string();
                self.persist_error = Some(msg.clone());
                Some(msg)
            }
        }
    }

    pub fn handle_line(
        &mut self,
        line: &str,
        wall_ms: i64,
        mono_ms: i64,
        nonce: [u8; 16],
        platform: &mut dyn Platform,
    ) -> String {
        let resp = match serde_json::from_str::<Request>(line) {
            Ok(req) => {
                let is_status = req == Request::GetStatus;
                let mut resp = ipc::handle(&mut self.store, &mut self.clock, req, wall_ms, mono_ms, nonce);
                if is_status {
                    if let Response::Status { warnings, .. } = &mut resp {
                        *warnings = self.warnings();
                    }
                } else {
                    let failed = self.save();
                    let now = self.clock.now(wall_ms, mono_ms);
                    self.apply(now, platform);
                    if let (Some(e), false) = (failed, matches!(resp, Response::Error { .. })) {
                        resp = Response::Error {
                            code: "persist-failed".into(),
                            message: format!("applied in memory but could not be saved: {e}; it will be lost on restart"),
                        };
                    }
                }
                resp
            }
            Err(e) => Response::Error { code: "bad-request".into(), message: e.to_string() },
        };
        serde_json::to_string(&resp).unwrap_or_else(|_| {
            r#"{"type":"Error","code":"bad-request","message":"serialize failed"}"#.to_string()
        })
    }

    /// Whether the service Stop control may be honored now (no locked/frozen window is active),
    /// judged on the effective clock.
    pub fn stop_allowed(&mut self, wall_ms: i64, mono_ms: i64) -> bool {
        let now = self.clock.now(wall_ms, mono_ms);
        crate::service_logic::stop_allowed(&self.store.windows, now)
    }

    pub fn tick(&mut self, wall_ms: i64, mono_ms: i64, platform: &mut dyn Platform) {
        let now = self.clock.now(wall_ms, mono_ms);
        if self.clock.high_water_ms() > self.store.high_water_ms {
            self.store.high_water_ms = self.clock.high_water_ms();
        }
        self.apply(now, platform);
        if self.persist_error.is_some() {
            self.save();
            return;
        }
        match self.last_saved_ms {
            None => self.last_saved_ms = Some(now),
            Some(last) if now - last >= PERSIST_INTERVAL_MS => {
                self.save();
            }
            Some(_) => {}
        }
    }

    fn apply(&mut self, now: i64, platform: &mut dyn Platform) {
        let decision = decide(&self.store.windows, now);
        enforce_once(&decision, platform.process_table(), std::process::id());

        let mut errors = Vec::new();
        let mut sites = decision.block_sites.clone();
        sites.sort();
        sites.dedup();
        if self.last_sites.as_ref() != Some(&sites) {
            match platform.enforce_hosts(&sites) {
                Ok(_) => self.last_sites = Some(sites),
                Err(e) => errors.push(format!("hosts: {e}")),
            }
            // Flush regardless of the hosts result: stale cache entries must not linger.
            if let Err(e) = platform.flush_dns() {
                errors.push(format!("dns: {e}"));
            }
        }

        if any_window_active(&decision) {
            if !self.doh_on {
                match platform.set_doh_off() {
                    Ok(w) => {
                        self.doh_on = true;
                        self.doh_startup_done = true;
                        self.doh_warnings = w;
                    }
                    Err(e) => errors.push(format!("doh: {e}")),
                }
            }
        } else if self.doh_on || !self.doh_warnings.is_empty() || !self.doh_startup_done {
            match platform.clear_doh_off() {
                Ok(()) => {
                    self.doh_on = false;
                    self.doh_startup_done = true;
                    self.doh_warnings.clear();
                }
                Err(e) => errors.push(format!("doh: {e}")),
            }
        }
        self.error_warnings = errors;
    }
}
