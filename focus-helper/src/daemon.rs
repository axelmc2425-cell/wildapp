//! Portable daemon logic: owns the lock store and clock, applies decisions to a `Platform`.
//! No Windows code here; the real platform and the service wrapper live in `win`.

use std::io;
use std::path::{Path, PathBuf};

use crate::clock::EffectiveClock;
use crate::decide::decide;
use crate::enforce::{any_window_active, enforce_once, ProcessTable};
use crate::ipc::{self, Request, Response};
use crate::lockstore::LockStore;
use crate::model::Mode;
use crate::persist;
use crate::sites::stems_from_domains;
use crate::sessions::{self, DayStretches, SessionStore};
use crate::usage::{self, DayUsage, Sample, UsageLoad, UsageStore};

/// A reported day may differ from the UTC date by this many days (time zones, midnight).
const MAX_DAY_SKEW: i64 = 2;
const MAX_EXE_CHARS: usize = 260;
const MAX_TITLE_CHARS: usize = 1024;

/// While block sites are active, re-assert the hosts file this often (effective ms): repairs
/// edits and ACL changes made behind the helper's back. A no-op when nothing differs.
pub const HOSTS_REAPPLY_INTERVAL_MS: i64 = 30_000;

/// Persist at least this often, in effective-clock milliseconds.
pub const PERSIST_INTERVAL_MS: i64 = 30_000;

/// Reports closer together than this are ignored (also stops two users' samplers from
/// double counting). In whole seconds of monotonic time.
pub const MIN_REPORT_GAP_SECS: i64 = 1;
/// `usage_tracking` is true while the latest report is at most this old (monotonic ms).
pub const REPORT_FRESH_MS: i64 = 15_000;
/// Usage is written at most this often (monotonic ms) while dirty.
pub const USAGE_FLUSH_INTERVAL_MS: i64 = 60_000;

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
    /// Effective time of the last `enforce_hosts` call that was made with the current sites.
    last_hosts_ms: i64,
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
    /// Set at load when state came from the backup or could not be read; shown in Status.
    state_warning: Option<String>,
    usage: UsageStore,
    usage_path: PathBuf,
    /// Set at load when the usage file was recovered or unreadable; shown in Status.
    usage_warning: Option<String>,
    /// Set while the latest usage save failed; cleared by the next successful save.
    usage_error: Option<String>,
    sessions_error: Option<String>,
    /// Latest reported day; the only clean day kept in memory.
    current_day: Option<String>,
    /// Monotonic time up to which reported seconds have been accounted; `None` before the first report.
    report_anchor_mono: Option<i64>,
    /// Monotonic time of the latest accepted report (drives `usage_tracking`).
    last_report_mono: Option<i64>,
    last_usage_flush_mono: Option<i64>,
    sessions: SessionStore,
    /// Directory of the `sessions-YYYY-MM-DD.json` files (the state directory).
    sessions_dir: PathBuf,
}

impl Daemon {
    /// Usage lives in `usage.json` next to the state file.
    pub fn load(state_path: &Path) -> Daemon {
        Daemon::load_with_usage(state_path, &state_path.with_file_name("usage.json"))
    }

    pub fn load_with_usage(state_path: &Path, usage_path: &Path) -> Daemon {
        let (store, source) = persist::load_with_report(state_path);
        let unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // Keep unreadable files out of the way of the first save, which would overwrite them.
        let moved = match source {
            persist::LoadSource::Backup | persist::LoadSource::DefaultAfterCorrupt => {
                persist::quarantine_corrupt(state_path, unix_ms)
            }
            _ => Vec::new(),
        };
        let state_warning = match source {
            persist::LoadSource::Backup => Some("state: loaded from backup".to_string()),
            persist::LoadSource::DefaultAfterCorrupt => {
                let kept = moved.first().map(|p| p.display().to_string()).unwrap_or_else(|| state_path.display().to_string());
                Some(format!("state: unreadable, started empty — previous state kept as {kept}"))
            }
            _ => None,
        };
        let (usage, usage_load) = usage::load(usage_path, unix_ms);
        let usage_warning = match usage_load {
            UsageLoad::Corrupt(p) => {
                Some(format!("usage: unreadable, started empty — previous file kept as {}", p.display()))
            }
            UsageLoad::Backup(Some(p)) => {
                Some(format!("usage: loaded from backup — unreadable file kept as {}", p.display()))
            }
            UsageLoad::Backup(None) => Some("usage: loaded from backup".to_string()),
            _ => None,
        };
        let clock = EffectiveClock::new(store.high_water_ms);
        Daemon {
            store,
            clock,
            state_path: state_path.to_path_buf(),
            last_sites: None,
            last_hosts_ms: 0,
            doh_on: false,
            doh_startup_done: false,
            doh_warnings: Vec::new(),
            error_warnings: Vec::new(),
            last_saved_ms: None,
            persist_error: None,
            state_warning,
            usage,
            usage_path: usage_path.to_path_buf(),
            usage_warning,
            usage_error: None,
            sessions_error: None,
            current_day: None,
            report_anchor_mono: None,
            last_report_mono: None,
            last_usage_flush_mono: None,
            sessions: SessionStore::new(),
            sessions_dir: match usage_path.parent() {
                Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
                _ => PathBuf::from("."),
            },
        }
    }

    pub fn store(&self) -> &LockStore {
        &self.store
    }

    /// DoH warnings followed by the latest platform errors.
    pub fn warnings(&self) -> Vec<String> {
        self.state_warning
            .iter()
            .cloned()
            .chain(self.usage_warning.iter().cloned())
            .chain(self.usage_error.iter().map(|e| format!("usage: {e}")))
            .chain(self.sessions_error.iter().map(|e| format!("sessions: {e}")))
            .chain(self.persist_error.iter().map(|e| format!("persist: {e}")))
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

    /// Writes the usage store and the dirty session days now.
    pub fn flush_usage(&mut self) {
        if self.usage.dirty() {
            self.usage.prune();
            match usage::save(&self.usage_path, &self.usage) {
                Ok(()) => {
                    self.usage.mark_clean();
                    self.usage_error = None;
                }
                Err(e) => {
                    eprintln!("focus-helper: usage save failed: {e}");
                    self.usage_error = Some(e.to_string());
                }
            }
        }
        self.flush_sessions();
    }

    fn flush_sessions(&mut self) {
        let dirty = self.sessions.dirty_days();
        if dirty.is_empty() {
            return;
        }
        self.prune_sessions();
        let mut failed = None;
        for day in self.sessions.dirty_days() {
            if let Some(d) = self.sessions.day(&day) {
                match sessions::save_day(&self.sessions_dir, &day, &d) {
                    Ok(()) => self.sessions.mark_day_clean(&day),
                    Err(e) => {
                        eprintln!("focus-helper: sessions save failed: {e}");
                        failed = Some(e.to_string());
                    }
                }
            } else {
                self.sessions.mark_day_clean(&day);
            }
        }
        self.sessions_error = failed;
        let keep = self.current_day.clone();
        self.sessions.evict_clean_except(keep.as_deref());
    }

    /// Keeps the newest 90 days, counting days on disk as well as those in memory.
    fn prune_sessions(&mut self) {
        self.sessions.prune();
        let mut days: std::collections::BTreeSet<String> = std::fs::read_dir(&self.sessions_dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let day = name.strip_prefix("sessions-")?.get(..10)?.to_string();
                usage::is_valid_day(&day).then_some(day)
            })
            .collect();
        for d in self.sessions.dirty_days() {
            days.insert(d);
        }
        let keep: Vec<String> = days.into_iter().rev().take(sessions::KEEP_SESSION_DAYS).collect();
        sessions::delete_old_files(&self.sessions_dir, &keep);
    }

    /// Loads `day` from disk into memory unless already there.
    fn ensure_day_loaded(&mut self, day: &str) {
        if !usage::is_valid_day(day) || self.sessions.has_day(day) {
            return;
        }
        if let Some(d) = self.read_day_from_disk(day) {
            self.sessions.insert_loaded(day, d);
        }
    }

    fn read_day_from_disk(&self, day: &str) -> Option<DayStretches> {
        let unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        sessions::load_day(&self.sessions_dir, day, unix_ms).map(|(d, _)| d)
    }

    /// Days of stretches currently held in memory.
    pub fn loaded_day_count(&self) -> usize {
        self.sessions.loaded_day_count()
    }

    /// Test seeding: replaces the day and saves immediately.
    pub fn add_usage(&mut self, day: DayUsage) {
        self.usage.add_day(day);
        self.flush_usage();
    }

    /// Test seeding: replaces the day's stretches and saves immediately.
    pub fn add_sessions(&mut self, day: &str, d: DayStretches) {
        self.sessions.set_day(day, d);
        self.flush_sessions();
    }

    /// Flushes usage and sessions when dirty and a minute has passed since the last flush.
    fn maybe_flush_usage(&mut self, mono_ms: i64) {
        let last = *self.last_usage_flush_mono.get_or_insert(mono_ms);
        if (self.usage.dirty() || !self.sessions.dirty_days().is_empty()) && mono_ms - last >= USAGE_FLUSH_INTERVAL_MS {
            self.last_usage_flush_mono = Some(mono_ms);
            self.flush_usage();
        }
    }

    /// Whether a sampler has reported recently.
    fn usage_tracking(&self, mono_ms: i64) -> bool {
        self.last_report_mono.is_some_and(|t| mono_ms - t <= REPORT_FRESH_MS)
    }

    /// Accounts one report from a sampler. The caller has validated the fields.
    fn report_foreground(&mut self, sample: Sample, now: i64, wall_ms: i64, mono_ms: i64) {
        self.last_report_mono = Some(mono_ms);
        let Some(anchor) = self.report_anchor_mono else {
            self.report_anchor_mono = Some(mono_ms);
            self.last_usage_flush_mono.get_or_insert(mono_ms);
            return;
        };
        let elapsed = (mono_ms - anchor).max(0) / 1000;
        if elapsed < MIN_REPORT_GAP_SECS {
            return;
        }
        // Keep the sub-second remainder for the next report so seconds are not truncated away.
        self.report_anchor_mono = Some(anchor + elapsed * 1000);
        let sites: Vec<String> = self
            .store
            .windows
            .iter()
            .filter(|w| w.mode == Mode::Block && w.starts <= now && now < w.ends)
            .flat_map(|w| w.sites.iter().cloned())
            .collect();
        let stems = stems_from_domains(&sites);
        if sample.idle_secs <= usage::IDLE_LIMIT_SECS {
            let secs = (elapsed as u64).min(usage::MAX_SAMPLE_SECS);
            let end = wall_ms.div_euclid(1000);
            let site = usage::site_label(&sample.exe, sample.title.as_deref(), &stems);
            self.current_day = Some(sample.day.clone());
            self.ensure_day_loaded(&sample.day);
            self.sessions.record(&sample.day, &sample.exe.to_lowercase(), site.as_deref(), end - secs as i64, end, secs);
        }
        self.usage.record(Some(&sample), elapsed as u64, &stems);
        self.maybe_flush_usage(mono_ms);
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
            Ok(Request::GetUsage { from_day, to_day }) => match self.usage.range(&from_day, &to_day) {
                Ok(days) => Response::Usage { days },
                Err(e) => Response::Error {
                    code: "bad-request".into(),
                    message: match e {
                        usage::RangeError::BadDay => "days must be YYYY-MM-DD",
                        usage::RangeError::Reversed => "from_day is after to_day",
                        usage::RangeError::TooLong => "range is longer than 400 days",
                    }
                    .into(),
                },
            },
            Ok(Request::GetSessions { day }) => {
                if !usage::is_valid_day(&day) {
                    Response::Error { code: "bad-request".into(), message: "day must be YYYY-MM-DD".into() }
                } else {
                    // Served from disk without keeping the day resident unless it already is.
                    let d = match self.sessions.day(&day) {
                        Some(d) => d,
                        None => self.read_day_from_disk(&day).unwrap_or_default(),
                    };
                    Response::Sessions { day, truncated: d.truncated, stretches: d.stretches }
                }
            }
            Ok(Request::ReportForeground { exe, title, idle_secs, day, hour }) => {
                let bad = |message: &str| Response::Error { code: "bad-request".into(), message: message.into() };
                if exe.is_empty() || exe.chars().count() > MAX_EXE_CHARS || exe.contains(['\\', '/']) {
                    bad("exe must be a program file name of 1 to 260 characters")
                } else if title.as_ref().is_some_and(|t| t.chars().count() > MAX_TITLE_CHARS) {
                    bad("title is longer than 1024 characters")
                } else if hour.is_some_and(|h| h > 23) {
                    bad("hour must be 0 to 23")
                } else if !usage::is_valid_day(&day) {
                    bad("day must be YYYY-MM-DD")
                } else if usage::day_number(&day).is_none_or(|n| (n - wall_ms.div_euclid(86_400_000)).abs() > MAX_DAY_SKEW) {
                    bad("day is too far from today")
                } else {
                    let now = self.clock.now(wall_ms, mono_ms);
                    self.report_foreground(Sample { exe, title, idle_secs, day, hour }, now, wall_ms, mono_ms);
                    Response::Ok
                }
            }
            Ok(req) => {
                let is_status = req == Request::GetStatus;
                let (mut resp, expired) = ipc::handle_changed(&mut self.store, &mut self.clock, req, wall_ms, mono_ms, nonce);
                if is_status {
                    // A due delayed unlock is applied on any request; persist and enforce it now.
                    if expired {
                        self.save();
                        let now = self.clock.now(wall_ms, mono_ms);
                        self.apply(now, platform);
                    }
                    if let Response::Status { warnings, usage_tracking, .. } = &mut resp {
                        *warnings = self.warnings();
                        *usage_tracking = self.usage_tracking(mono_ms);
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
        self.store.prune_tombstones(now);
        let expired = self.store.expire_pending(now);
        self.apply(now, platform);
        self.maybe_flush_usage(mono_ms);
        if self.persist_error.is_some() || expired {
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
                Ok(_) => {
                    self.last_sites = Some(sites);
                    self.last_hosts_ms = now;
                }
                Err(e) => errors.push(format!("hosts: {e}")),
            }
            // Flush regardless of the hosts result: stale cache entries must not linger.
            if let Err(e) = platform.flush_dns() {
                errors.push(format!("dns: {e}"));
            }
        } else if !sites.is_empty() && now - self.last_hosts_ms >= HOSTS_REAPPLY_INTERVAL_MS {
            // Drift repair: the platform reports whether it had to rewrite anything.
            self.last_hosts_ms = now;
            match platform.enforce_hosts(&sites) {
                Ok(true) => {
                    if let Err(e) = platform.flush_dns() {
                        errors.push(format!("dns: {e}"));
                    }
                }
                Ok(false) => {}
                Err(e) => errors.push(format!("hosts: {e}")),
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
