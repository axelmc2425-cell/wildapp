//! Portable per-day store of "stretches": continuous foreground intervals to the second.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::usage::{is_valid_day, with_suffix};

pub const MAX_STRETCHES_PER_DAY: usize = 20_000;
pub const KEEP_SESSION_DAYS: usize = 90;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stretch {
    pub start: i64,
    pub end: i64,
    pub exe: String,
    pub site: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DayStretches {
    pub truncated: bool,
    pub stretches: Vec<Stretch>,
}

#[derive(Debug, Default)]
pub struct SessionStore {
    days: BTreeMap<String, DayStretches>,
    dirty: BTreeSet<String>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records one foreground interval. `interval_secs` is the report interval, used for
    /// the merge gap tolerance `max(2, 2 * interval_secs)`.
    pub fn record(
        &mut self,
        day: &str,
        exe: &str,
        site: Option<&str>,
        start: i64,
        end: i64,
        interval_secs: u64,
    ) {
        if !is_valid_day(day) || end <= start {
            return;
        }
        let gap = interval_secs.saturating_mul(2).max(2).min(i64::MAX as u64) as i64;
        let d = self.days.entry(day.to_string()).or_default();
        let mut start = start;
        if let Some(last) = d.stretches.last_mut() {
            if end <= last.end {
                return; // clock moved back or duplicate report
            }
            start = start.max(last.end); // never overlap the previous stretch
            if end <= start {
                return;
            }
            if last.exe == exe && last.site.as_deref() == site && start.saturating_sub(last.end) <= gap {
                last.end = end;
                self.dirty.insert(day.to_string());
                return;
            }
        }
        if d.stretches.len() >= MAX_STRETCHES_PER_DAY {
            if !d.truncated {
                d.truncated = true;
                self.dirty.insert(day.to_string());
            }
            return;
        }
        d.stretches.push(Stretch { start, end, exe: exe.to_string(), site: site.map(String::from) });
        self.dirty.insert(day.to_string());
    }

    pub fn day(&self, day: &str) -> Option<DayStretches> {
        self.days.get(day).cloned()
    }

    /// Replaces the day (test seeding / loading).
    pub fn set_day(&mut self, day: &str, d: DayStretches) {
        if !is_valid_day(day) {
            return;
        }
        self.days.insert(day.to_string(), d);
        self.dirty.insert(day.to_string());
    }

    /// Inserts a day read from disk without marking it dirty.
    pub fn insert_loaded(&mut self, day: &str, d: DayStretches) {
        if is_valid_day(day) {
            self.days.insert(day.to_string(), d);
        }
    }

    pub fn has_day(&self, day: &str) -> bool {
        self.days.contains_key(day)
    }

    /// Keeps the newest `KEEP_SESSION_DAYS` days.
    pub fn prune(&mut self) {
        while self.days.len() > KEEP_SESSION_DAYS {
            if let Some((k, _)) = self.days.pop_first() {
                self.dirty.remove(&k);
            }
        }
    }

    pub fn dirty_days(&self) -> Vec<String> {
        self.dirty.iter().cloned().collect()
    }

    pub fn mark_clean(&mut self) {
        self.dirty.clear();
    }
}

#[derive(Serialize, Deserialize)]
struct FileV1 {
    version: u32,
    truncated: bool,
    stretches: Vec<Stretch>,
}

/// `None` unless `day` is a real `YYYY-MM-DD` (so it can never escape `dir`).
pub fn session_file(dir: &Path, day: &str) -> Option<PathBuf> {
    is_valid_day(day).then(|| dir.join(format!("sessions-{day}.json")))
}

fn read_day(path: &Path) -> Option<DayStretches> {
    let raw = fs::read(path).ok()?;
    let f: FileV1 = serde_json::from_slice(&raw).ok()?;
    if f.version != 1 {
        return None;
    }
    Some(DayStretches { truncated: f.truncated, stretches: f.stretches })
}

/// Atomic save: previous good file kept as `.bak`, new state to `.tmp`, fsync, rename.
pub fn save_day(dir: &Path, day: &str, d: &DayStretches) -> io::Result<()> {
    let path = session_file(dir, day)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid day"))?;
    let bak = with_suffix(&path, ".bak");
    let tmp = with_suffix(&path, ".tmp");
    if path.exists() && read_day(&path).is_some() {
        fs::copy(&path, &bak)?;
    }
    let file = FileV1 { version: 1, truncated: d.truncated, stretches: d.stretches.clone() };
    let json = serde_json::to_vec(&file).map_err(io::Error::other)?;
    let mut f = File::create(&tmp)?;
    f.write_all(&json)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, &path)?;
    #[cfg(unix)]
    {
        let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir };
        if let Ok(h) = File::open(dir) {
            let _ = h.sync_all();
        }
    }
    Ok(())
}

/// Loads a day. The bool is true when it came from the backup. Unparseable files are renamed
/// to `<name>.corrupt-<unix_ms>`; `None` when nothing usable exists.
pub fn load_day(dir: &Path, day: &str, unix_ms: i64) -> Option<(DayStretches, bool)> {
    let path = session_file(dir, day)?;
    if let Some(d) = read_day(&path) {
        return Some((d, false));
    }
    let bak = with_suffix(&path, ".bak");
    let backup = read_day(&bak);
    for p in [&path, &bak] {
        if p.exists() && read_day(p).is_none() {
            let _ = fs::rename(p, with_suffix(p, &format!(".corrupt-{unix_ms}")));
        }
    }
    backup.map(|d| (d, true))
}

/// Deletes `sessions-<day>.json` (and `.bak`/`.tmp`) for days not in `keep_days`.
pub fn delete_old_files(dir: &Path, keep_days: &[String]) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix("sessions-") else { continue };
        let Some(day) = rest.get(..10) else { continue };
        let tail = &rest[10..];
        if !is_valid_day(day) || !(tail == ".json" || tail == ".json.bak" || tail == ".json.tmp") {
            continue;
        }
        if !keep_days.iter().any(|k| k == day) {
            let _ = fs::remove_file(e.path());
        }
    }
}
