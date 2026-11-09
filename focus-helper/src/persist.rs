//! Crash-safe persistence: previous good state kept as `.bak`, new state written to `.tmp`,
//! fsynced, then renamed over the main file. Unparseable files are never deleted by `load`.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::lockstore::LockStore;

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

fn read_store(path: &Path) -> Option<LockStore> {
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

pub fn save(path: &Path, store: &LockStore) -> io::Result<()> {
    let bak = with_suffix(path, ".bak");
    let tmp = with_suffix(path, ".tmp");
    // Only back up a main file that parses, so a corrupt main never replaces a good .bak.
    if path.exists() && read_store(path).is_some() {
        fs::copy(path, &bak)?;
    }
    let json = serde_json::to_vec(store).map_err(io::Error::other)?;
    let mut f = File::create(&tmp)?;
    f.write_all(&json)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)?;
    // Best effort: make the rename itself durable. Not possible on Windows.
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir };
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Where `load_with_report` got its state from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadSource {
    /// The main file parsed.
    Main,
    /// The main file was missing or unreadable; the `.bak` parsed.
    Backup,
    /// No state files existed: a fresh start.
    Default,
    /// State files exist but none parses: started empty (the caller should keep the corrupt files).
    DefaultAfterCorrupt,
}

pub fn load_with_report(path: &Path) -> (LockStore, LoadSource) {
    let bak = with_suffix(path, ".bak");
    if let Some(s) = read_store(path) {
        return (s, LoadSource::Main);
    }
    if let Some(s) = read_store(&bak) {
        return (s, LoadSource::Backup);
    }
    if path.exists() || bak.exists() {
        (LockStore::default(), LoadSource::DefaultAfterCorrupt)
    } else {
        (LockStore::default(), LoadSource::Default)
    }
}

pub fn load(path: &Path) -> LockStore {
    load_with_report(path).0
}

/// Renames every existing state file (main and `.bak`) that does not parse to
/// `<name>.corrupt-<unix_ms>`, so a later save can never overwrite it. Returns the new paths.
pub fn quarantine_corrupt(path: &Path, unix_ms: i64) -> Vec<PathBuf> {
    let mut moved = Vec::new();
    for p in [path.to_path_buf(), with_suffix(path, ".bak")] {
        if p.exists() && read_store(&p).is_none() {
            let target = with_suffix(&p, &format!(".corrupt-{unix_ms}"));
            if fs::rename(&p, &target).is_ok() {
                moved.push(target);
            }
        }
    }
    moved
}
