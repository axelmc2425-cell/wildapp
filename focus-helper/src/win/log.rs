//! Minimal best-effort service log: `%ProgramData%\MyBrainFocus\service.log` (inside the
//! locked-down state dir), append-only, capped at 1 MiB and rotated once to `service.log.old`.
//! Never panics and never reports failure.

use std::fs::{self, OpenOptions};
use std::io::Write;

use crate::service_logic::{log_line, LOG_FILE, LOG_MAX_BYTES};
use crate::win::paths;

pub fn log(msg: &str) {
    let dir = paths::state_dir();
    let path = dir.join(LOG_FILE);
    if fs::metadata(&path).map(|m| m.len() >= LOG_MAX_BYTES).unwrap_or(false) {
        let old = dir.join(format!("{LOG_FILE}.old"));
        let _ = fs::remove_file(&old);
        let _ = fs::rename(&path, &old);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(log_line(paths::wall_ms(), msg).as_bytes());
    }
    eprintln!("focus-helper: {msg}");
}
