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
    fs::rename(&tmp, path)
}

pub fn load(path: &Path) -> LockStore {
    read_store(path).or_else(|| read_store(&with_suffix(path, ".bak"))).unwrap_or_default()
}
