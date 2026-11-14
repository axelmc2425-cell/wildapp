//! Portable daemon logic: owns the lock store and clock, applies decisions to a `Platform`.
//! No Windows code here; the real platform and the service wrapper live in `win`.

use std::io;
use std::path::{Path, PathBuf};

use crate::clock::EffectiveClock;
use crate::decide::decide;
use crate::enforce::{any_window_active, enforce_with, ProcessTable};
use crate::ipc::{self, LimitStatus, Request, Response};
use crate::limits::{period_days, period_ends_day, used_secs, Limit};
use crate::lockstore::LockStore;
use crate::model::{Decision, LimitBlock, Mode};
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

/// Used time of one limit, kept until usage, the day or the limits change.
struct LimitEval {
    used: u64,
    blocked: bool,
    ends_day: String,
}

struct LimitCache {
    usage_gen: u64,
    day: String,
    limits: Vec<Limit>,
    evals: Vec<LimitEval>,
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
    /// Set when a stretch file was quarantined or recovered from its backup; shown in Status.
    sessions_warning: Option<String>,
    /// Latest reported day; the only clean day kept in memory.
    current_day: Option<String>,
    /// Monotonic time up to which reported seconds have been accounted; `None` before the first report.
    report_anchor_mono: Option<i64>,
    /// Monotonic time of the latest accepted report (drives `usage_tracking`).
    last_report_mono: Option<i64>,
    last_usage_flush_mono: Option<i64>,
    /// Bumped whenever recorded usage changes (invalidates the limit cache).
    usage_gen: u64,
    limit_cache: Option<LimitCache>,
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
        let wall_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Daemon::load_with_usage_at(state_path, usage_path, wall_ms)
    }

    /// Like `load_with_usage` with the wall clock given (a seam for tests).
    pub fn load_with_usage_at(state_path: &Path, usage_path: &Path, wall_ms: i64) -> Daemon {
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
        // Limits keep blocking across a restart: until a sampler reports, the latest day with
        // recorded usage stands in for today (at worst yesterday's period, which fails safe). Only a valid day no later than UTC date + 1
        // counts, so a future or garbage persisted day cannot pin the day forward and lift limits.
        let current_day = usage.latest_day_at_most(wall_ms.div_euclid(86_400_000) + 1);
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
            sessions_warning: None,
            current_day,
            report_anchor_mono: None,
            last_report_mono: None,
            last_usage_flush_mono: None,
            usage_gen: 0,
            limit_cache: None,
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
            .chain(self.sessions_warning.iter().cloned())
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

    fn read_day_from_disk(&mut self, day: &str) -> Option<DayStretches> {
        let unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let l = sessions::load_day(&self.sessions_dir, day, unix_ms);
        if let Some(p) = &l.quarantined {
            self.sessions_warning = Some(if l.from_backup {
                format!("sessions: {day} loaded from backup — unreadable file kept as {}", p.display())
            } else {
                format!("sessions: {day} unreadable, kept as {}", p.display())
            });
        } else if l.from_backup {
            self.sessions_warning = Some(format!("sessions: {day} loaded from backup"));
        }
        l.day
    }

    /// Days of stretches currently held in memory.
    pub fn loaded_day_count(&self) -> usize {
        self.sessions.loaded_day_count()
    }

    /// Test seeding: replaces the day and saves immediately.
    pub fn add_usage(&mut self, day: DayUsage) {
        self.usage.add_day(day);
        self.usage_gen += 1;
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

    /// Recomputes the cached used time of every limit when usage, the day or the limits changed.
    /// Reads in-memory usage only. With no reported day there is nothing to evaluate.
    fn refresh_limit_cache(&mut self) {
        let Some(day) = self.current_day.clone() else {
            self.limit_cache = None;
            return;
        };
        if let Some(c) = &self.limit_cache {
            if c.usage_gen == self.usage_gen && c.day == day && c.limits == self.store.limits {
                return;
            }
        }
        // At most two distinct periods (daily, weekly): read each range once and share it.
        let mut ranges: Vec<((String, String), Vec<crate::usage::DayUsage>)> = Vec::new();
        let evals = self
            .store
            .limits
            .iter()
            .map(|l| {
                let key = period_days(l.period, &day).unwrap_or((day.clone(), day.clone()));
                if !ranges.iter().any(|(k, _)| *k == key) {
                    let days = self.usage.range(&key.0, &key.1).unwrap_or_default();
                    ranges.push((key.clone(), days));
                }
                let days = &ranges.iter().find(|(k, _)| *k == key).unwrap().1;
                let used = used_secs(l, days, &day);
                LimitEval {
                    used,
                    blocked: used >= l.cap_secs,
                    ends_day: period_ends_day(l.period, &day).unwrap_or_default(),
                }
            })
            .collect();
        self.limit_cache = Some(LimitCache { usage_gen: self.usage_gen, day, limits: self.store.limits.clone(), evals });
    }

    fn limit_statuses(&mut self) -> Vec<LimitStatus> {
        self.refresh_limit_cache();
        let Some(c) = &self.limit_cache else { return Vec::new() };
        c.limits
            .iter()
            .zip(&c.evals)
            .map(|(l, e)| LimitStatus {
                id: l.id.clone(),
                used_secs: e.used,
                cap_secs: l.cap_secs,
                blocked: e.blocked,
                period_ends_day: e.ends_day.clone(),
            })
            .collect()
    }

    /// The window decision plus the apps and sites of every exceeded limit. Allow-list windows
    /// are left as they are.
    fn full_decision(&mut self, now: i64) -> Decision {
        let mut d = decide(&self.store.windows, now);
        self.refresh_limit_cache();
        let Some(c) = &self.limit_cache else { return d };
        let mut blocks = Vec::new();
        for (l, e) in c.limits.iter().zip(&c.evals) {
            if !e.blocked {
                continue;
            }
            d.block_apps.extend(l.apps.iter().map(|a| a.trim().to_lowercase()));
            d.block_sites.extend(l.sites.iter().map(|s| s.trim().to_lowercase()));
            blocks.push(LimitBlock { id: l.id.clone(), until_day: e.ends_day.clone() });
        }
        if !blocks.is_empty() {
            blocks.sort_by(|a, b| a.id.cmp(&b.id));
            d.block_apps.sort();
            d.block_apps.dedup();
            d.block_sites.sort();
            d.block_sites.dedup();
            d.limit_blocks = blocks;
        }
        d
    }

    /// Whether a sampler has reported recently.
    fn usage_tracking(&self, mono_ms: i64) -> bool {
        self.last_report_mono.is_some_and(|t| mono_ms - t <= REPORT_FRESH_MS)
    }

    /// Accounts one report from a sampler. The caller has validated the fields.
    fn report_foreground(&mut self, sample: Sample, now: i64, wall_ms: i64, mono_ms: i64) {
        self.last_report_mono = Some(mono_ms);
        // The latest day reported; a report with an earlier day never moves it back, so used time
        // is never lowered and a block is never lifted by a clock that went backwards. A day more
        // than one day past the UTC date (local dates differ from UTC by at most one day) is still
        // recorded as usage but never becomes the current day, so a forward-day report cannot
        // reset a limit. Residual, accepted: a local user who can write to the pipe can still
        // spoof one day ahead, the same trust level as spoofing usage reports.
        let utc_day = wall_ms.div_euclid(86_400_000);
        let plausible = usage::day_number(&sample.day).is_some_and(|n| n <= utc_day + 1);
        if plausible && self.current_day.as_deref().is_none_or(|c| sample.day.as_str() > c) {
            self.current_day = Some(sample.day.clone());
        }
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
        // Block windows' sites and every limit's sites label browser samples by their stem.
        let sites: Vec<String> = self
            .store
            .windows
            .iter()
            .filter(|w| w.mode == Mode::Block && w.starts <= now && now < w.ends)
            .flat_map(|w| w.sites.iter().cloned())
            .chain(self.store.limits.iter().flat_map(|l| l.sites.iter().cloned()))
            .collect();
        let stems = stems_from_domains(&sites);
        if sample.idle_secs <= usage::IDLE_LIMIT_SECS {
            let secs = (elapsed as u64).min(usage::MAX_SAMPLE_SECS);
            let end = wall_ms.div_euclid(1000);
            // Gap tolerance follows the sampler's nominal interval, not the (capped) elapsed time,
            // so a lock or stall never lets a stretch be extended over time that was not counted.
            let nominal = if secs <= 5 { secs } else { 1 };
            let site = usage::site_label(&sample.exe, sample.title.as_deref(), &stems);
            self.ensure_day_loaded(&sample.day);
            self.sessions.record(&sample.day, &sample.exe.to_lowercase(), site.as_deref(), end - secs as i64, end, nominal);
        }
        self.usage.record(Some(&sample), elapsed as u64, &stems);
        self.usage_gen += 1;
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
            Ok(Request::PushLimits { limits }) => {
                let now = self.clock.now(wall_ms, mono_ms);
                self.store.expire_pending(now);
                match self.store.push_limits(limits, now) {
                    Ok(r) => {
                        let failed = self.save();
                        self.apply(now, platform);
                        match failed {
                            Some(e) => Response::Error {
                                code: "persist-failed".into(),
                                message: format!("applied in memory but could not be saved: {e}; it will be lost on restart"),
                            },
                            None => Response::LimitsPushed {
                                applied: r.applied,
                                kept_locked: r.kept_locked,
                                skipped_tombstoned: r.skipped_tombstoned,
                            },
                        }
                    }
                    Err(e) => ipc::limit_push_error(e),
                }
            }
            Ok(Request::GetLimits) => {
                let now = self.clock.now(wall_ms, mono_ms);
                if self.store.expire_pending(now) {
                    self.save();
                    self.apply(now, platform);
                }
                let status = self.limit_statuses();
                let pending_unlocks = self
                    .store
                    .pending_unlocks
                    .iter()
                    .filter(|p| p.window_id.starts_with(crate::limits::LIMIT_ID_PREFIX))
                    .cloned()
                    .collect();
                Response::Limits { limits: self.store.limits.clone(), status, pending_unlocks }
            }
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
                    if let Response::Status { decision, .. } = &mut resp {
                        let now = self.clock.now(wall_ms, mono_ms);
                        *decision = self.full_decision(now);
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
        // The VPN-kill and DoH-off friction follow the block WINDOWS only. A used-up limit adds
        // its apps and sites to the block lists but never counts as an active window. Accepted
        // consequence: DoH and VPNs can bypass a site limit (same trust level as the rest of the
        // friction design).
        let friction = any_window_active(&decide(&self.store.windows, now));
        let decision = self.full_decision(now);
        enforce_with(&decision, platform.process_table(), std::process::id(), friction);

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

        if friction {
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
