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

    /// Number of days held in memory.
    pub fn loaded_day_count(&self) -> usize {
        self.days.len()
    }

    pub fn mark_day_clean(&mut self, day: &str) {
        self.dirty.remove(day);
    }

    /// Drops days that are not dirty, except `keep`.
    pub fn evict_clean_except(&mut self, keep: Option<&str>) {
        let dirty = &self.dirty;
        self.days.retain(|k, _| dirty.contains(k) || Some(k.as_str()) == keep);
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

enum Read {
    Ok(DayStretches),
    Missing,
    /// The bytes were read but are not a valid day file.
    Bad,
    /// The file exists but could not be read (sharing violation, permission, ...).
    Unreadable,
}

fn read_file(path: &Path) -> Read {
    let raw = match fs::read(path) {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Read::Missing,
        Err(_) => return Read::Unreadable,
    };
    match serde_json::from_slice::<FileV1>(&raw) {
        Ok(f) if f.version == 1 => Read::Ok(DayStretches { truncated: f.truncated, stretches: f.stretches }),
        _ => Read::Bad,
    }
}

fn read_day(path: &Path) -> Option<DayStretches> {
    match read_file(path) {
        Read::Ok(d) => Some(d),
        _ => None,
    }
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

/// Result of `load_day`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DayLoad {
    /// `None` when nothing usable exists (or a file could not be read right now).
    pub day: Option<DayStretches>,
    /// True when `day` came from the backup.
    pub from_backup: bool,
    /// Where the unparseable main file was moved to, if it was.
    pub quarantined: Option<PathBuf>,
}

/// Loads a day. Files that were read but do not parse are renamed to
/// `<name>.corrupt-<unix_ms>`. A file that cannot be read at all (transient error) is left
/// untouched and nothing is renamed, so the next attempt can try again.
pub fn load_day(dir: &Path, day: &str, unix_ms: i64) -> DayLoad {
    let Some(path) = session_file(dir, day) else { return DayLoad::default() };
    let main = read_file(&path);
    if let Read::Ok(d) = main {
        return DayLoad { day: Some(d), from_backup: false, quarantined: None };
    }
    let bak = with_suffix(&path, ".bak");
    let backup = read_file(&bak);
    if matches!(main, Read::Unreadable) || matches!(backup, Read::Unreadable) {
        return DayLoad::default();
    }
    let mut quarantined = None;
    for (p, r) in [(&path, &main), (&bak, &backup)] {
        if matches!(r, Read::Bad) {
            let to = with_suffix(p, &format!(".corrupt-{unix_ms}"));
            if fs::rename(p, &to).is_ok() && quarantined.is_none() {
                quarantined = Some(to);
            }
        }
    }
    match backup {
        Read::Ok(d) => DayLoad { day: Some(d), from_backup: true, quarantined },
        _ => DayLoad { day: None, from_backup: false, quarantined },
    }
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
