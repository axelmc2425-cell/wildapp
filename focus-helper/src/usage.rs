//! Portable usage accounting: foreground seconds per local day, per program and per website.
//! Window titles are only inspected in memory to pick a site label; they are never stored.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Write};
use std::ops::Bound;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::sites::{is_browser, match_site};

/// One foreground observation. `exe` is the base name; `title` is set only for browsers.
#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    pub exe: String,
    pub title: Option<String>,
    pub idle_secs: u64,
    /// Local calendar day, `YYYY-MM-DD`.
    pub day: String,
    /// Local hour of day, 0 to 23, when the sampler reported one.
    pub hour: Option<u8>,
}

/// File name of a Windows (or forward-slash) path; the whole input when it has no separator.
pub fn base_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or("").to_string()
}

/// `YYYY-MM-DD` for a local calendar date.
pub fn day_string(y: u16, m: u16, d: u16) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

/// Seconds a single sample may add, so a stall or suspend never invents time.
pub const MAX_SAMPLE_SECS: u64 = 15;
/// Last input older than this counts nothing.
pub const IDLE_LIMIT_SECS: u64 = 300;
/// Programs (and websites) kept per day; the rest roll into `other`.
pub const MAX_NAMES: usize = 200;
/// Days of history kept.
pub const KEEP_DAYS: usize = 730;
/// Longest range `range` serves, inclusive.
pub const MAX_RANGE_DAYS: i64 = 400;

/// Longest program or site name stored.
pub const MAX_NAME_CHARS: usize = 64;

/// `s` cut to at most `max` characters, always on a character boundary.
pub fn truncate_title(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

const OTHER: &str = "other";

/// The website label for a browser sample (`None` for other programs or unmatched titles).
pub fn site_label(exe: &str, title: Option<&str>, stems: &[String]) -> Option<String> {
    if !is_browser(exe) {
        return None;
    }
    title.and_then(|t| match_site(t, stems))
}

#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Eq, Debug)]
pub struct DayUsage {
    pub day: String,
    pub total: u64,
    pub apps: BTreeMap<String, u64>,
    pub sites: BTreeMap<String, u64>,
    pub other_browsing: u64,
    /// Seconds per local hour. Empty means not recorded; otherwise exactly 24 slots.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hours: Vec<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeError {
    BadDay,
    Reversed,
    TooLong,
}

#[derive(Default, Debug)]
pub struct UsageStore {
    days: BTreeMap<String, DayUsage>,
    dirty: bool,
}

impl PartialEq for UsageStore {
    /// Equality of the recorded data; the dirty flag is bookkeeping.
    fn eq(&self, other: &Self) -> bool {
        self.days == other.days
    }
}

fn add_capped(map: &mut BTreeMap<String, u64>, key: &str, secs: u64) {
    let key = truncate_title(key, MAX_NAME_CHARS);
    let key = key.as_str();
    let key = if map.contains_key(key) || map.len() < MAX_NAMES { key } else { OTHER };
    *map.entry(key.to_string()).or_insert(0) += secs;
}

/// `YYYY-MM-DD` with a real calendar date, as (year, month, day).
pub(crate) fn parse_day(s: &str) -> Option<(i64, i64, i64)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    if !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: i64 = s[5..7].parse().ok()?;
    let d: i64 = s[8..10].parse().ok()?;
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    (1..=dim).contains(&d).then_some((y, m, d))
}

/// Whether `s` is a real `YYYY-MM-DD` calendar date.
pub fn is_valid_day(s: &str) -> bool {
    parse_day(s).is_some()
}

/// Days since 1970-01-01 of a valid `YYYY-MM-DD`, else `None`.
pub fn day_number(s: &str) -> Option<i64> {
    parse_day(s).map(|(y, m, d)| days_from_civil(y, m, d))
}

/// Days since 1970-01-01 (Howard Hinnant's days-from-civil).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

impl UsageStore {
    pub fn new() -> UsageStore {
        UsageStore::default()
    }

    /// Adds `min(elapsed_secs, 15)` seconds for the sample. Nothing is added for no sample,
    /// an idle-over-limit sample, or zero elapsed time.
    pub fn record(&mut self, sample: Option<&Sample>, elapsed_secs: u64, stems: &[String]) {
        let Some(s) = sample else { return };
        if s.idle_secs > IDLE_LIMIT_SECS || elapsed_secs == 0 {
            return;
        }
        let secs = elapsed_secs.min(MAX_SAMPLE_SECS);
        let day = self
            .days
            .entry(s.day.clone())
            .or_insert_with(|| DayUsage { day: s.day.clone(), ..Default::default() });
        // A day that already holds seconds without hours stays unrecorded: never mix.
        if let Some(h) = s.hour.filter(|&h| h < 24) {
            if day.hours.is_empty() && day.total == 0 {
                day.hours = vec![0; 24];
            }
            if let Some(slot) = day.hours.get_mut(usize::from(h)) {
                *slot = slot.saturating_add(secs as u32);
            }
        }
        day.total += secs;
        add_capped(&mut day.apps, &s.exe.to_lowercase(), secs);
        if is_browser(&s.exe) {
            match site_label(&s.exe, s.title.as_deref(), stems) {
                Some(label) => add_capped(&mut day.sites, &label, secs),
                None => day.other_browsing += secs,
            }
        }
        self.dirty = true;
    }

    /// Days present in the inclusive range, ascending. At most 400 days wide.
    pub fn range(&self, from_day: &str, to_day: &str) -> Result<Vec<DayUsage>, RangeError> {
        let f = parse_day(from_day).ok_or(RangeError::BadDay)?;
        let t = parse_day(to_day).ok_or(RangeError::BadDay)?;
        let span = days_from_civil(t.0, t.1, t.2) - days_from_civil(f.0, f.1, f.2);
        if span < 0 {
            return Err(RangeError::Reversed);
        }
        if span + 1 > MAX_RANGE_DAYS {
            return Err(RangeError::TooLong);
        }
        // Both bounds are validated fixed-width strings, so string order is date order.
        Ok(self
            .days
            .range::<str, _>((Bound::Included(from_day), Bound::Included(to_day)))
            .map(|(_, d)| d.clone())
            .collect())
    }

    /// The latest day that has recorded usage.
    pub fn latest_day(&self) -> Option<String> {
        self.days.keys().next_back().cloned()
    }

    /// Replaces the day (test seeding).
    pub fn add_day(&mut self, d: DayUsage) {
        self.days.insert(d.day.clone(), d);
        self.dirty = true;
    }

    /// Keeps the newest `KEEP_DAYS` days.
    pub fn prune(&mut self) {
        while self.days.len() > KEEP_DAYS {
            self.days.pop_first();
            self.dirty = true;
        }
    }

    pub fn dirty(&self) -> bool {
        self.dirty
    }

    pub fn mark_clean(&mut self) {
        self.dirty = false;
    }
}

#[derive(Serialize, Deserialize)]
struct FileV1 {
    version: u32,
    days: Vec<DayUsage>,
}

pub(crate) fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

fn read_store(path: &Path) -> Option<UsageStore> {
    let raw = fs::read(path).ok()?;
    let f: FileV1 = serde_json::from_slice(&raw).ok()?;
    if f.version != 1 {
        return None;
    }
    let mut days = BTreeMap::new();
    for d in f.days {
        days.insert(d.day.clone(), d);
    }
    Some(UsageStore { days, dirty: false })
}

/// Atomic save: previous good file kept as `.bak`, new state to `.tmp`, fsync, rename.
pub fn save(path: &Path, store: &UsageStore) -> io::Result<()> {
    let bak = with_suffix(path, ".bak");
    let tmp = with_suffix(path, ".tmp");
    // Only back up a main file that parses, so a corrupt main never replaces a good .bak.
    if path.exists() && read_store(path).is_some() {
        fs::copy(path, &bak)?;
    }
    let file = FileV1 { version: 1, days: store.days.values().cloned().collect() };
    let json = serde_json::to_vec(&file).map_err(io::Error::other)?;
    let mut f = File::create(&tmp)?;
    f.write_all(&json)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)?;
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir };
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Where `load` got its state from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsageLoad {
    /// No state files: a fresh start.
    Fresh,
    Main,
    /// The main file was missing or unparseable; the `.bak` parsed. Carries the path an
    /// unparseable main file was quarantined to (or left at, if the rename failed).
    Backup(Option<PathBuf>),
    /// State files exist but none parsed; the store is empty. Carries the path the first
    /// unparseable file was quarantined to, or its original path if the rename failed, so
    /// it is never reported as `Fresh` and the caller knows not to trust a later overwrite.
    Corrupt(PathBuf),
}

/// Loads the store. Any state file that exists but does not parse is renamed to
/// `<name>.corrupt-<unix_ms>` so a later save can never overwrite it.
pub fn load(path: &Path, unix_ms: i64) -> (UsageStore, UsageLoad) {
    let bak = with_suffix(path, ".bak");
    if let Some(s) = read_store(path) {
        return (s, UsageLoad::Main);
    }
    // The main file is missing or unparseable. Quarantine each existing unparseable file
    // (the backup only when it is itself unparseable). A failed rename leaves the original path.
    let mut kept: Vec<PathBuf> = Vec::new();
    let backup = read_store(&bak);
    for p in [path.to_path_buf(), bak.clone()] {
        if p.exists() && read_store(&p).is_none() {
            let target = with_suffix(&p, &format!(".corrupt-{unix_ms}"));
            kept.push(if fs::rename(&p, &target).is_ok() { target } else { p });
        }
    }
    if let Some(s) = backup {
        return (s, UsageLoad::Backup(kept.into_iter().next()));
    }
    match kept.into_iter().next() {
        Some(p) => (UsageStore::new(), UsageLoad::Corrupt(p)),
        None => (UsageStore::new(), UsageLoad::Fresh),
    }
}
