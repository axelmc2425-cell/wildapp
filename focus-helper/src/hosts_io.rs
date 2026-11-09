//! Atomic writer for the hosts file (portable).

use crate::hosts;
use std::ffi::OsString;
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

fn tmp_path(path: &Path) -> PathBuf {
    let mut o: OsString = path.as_os_str().to_owned();
    o.push(".focus-tmp");
    PathBuf::from(o)
}

/// Render the managed block for `sites` into the hosts file at `path`.
/// Returns `Ok(true)` when the file was rewritten, `Ok(false)` when it already
/// matched (nothing is written). A non-UTF-8 file is never touched.
pub fn apply(path: &Path, sites: &[String]) -> io::Result<bool> {
    let existing = match fs::read(path) {
        Ok(b) => String::from_utf8(b)
            .map_err(|_| io::Error::new(ErrorKind::InvalidData, "hosts file is not valid UTF-8"))?,
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let next = hosts::render(&existing, sites);
    if next == existing {
        return Ok(false);
    }
    // Same directory as the target so the rename stays on one volume.
    // A leftover temp file from a crash is truncated, never read.
    let tmp = tmp_path(path);
    let written = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(next.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(true)
}
