//! Environment-derived paths and small process helpers shared by the service and installer.

use std::io;
use std::path::PathBuf;
use std::process::Command;

use crate::service_logic;
use crate::win::dns::sys32;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

pub fn program_files() -> String {
    env_or("ProgramFiles", r"C:\Program Files")
}

pub fn program_data() -> String {
    env_or("ProgramData", r"C:\ProgramData")
}

pub fn state_dir() -> PathBuf {
    PathBuf::from(service_logic::state_dir(&program_data()))
}

pub fn state_file() -> PathBuf {
    service_logic::state_file(&program_data())
}

/// Run an absolute-path tool, returning an error carrying its output on failure.
pub fn run_exe(exe: PathBuf, args: &[String]) -> io::Result<()> {
    let out = Command::new(&exe).args(args).output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} {:?} failed ({}): {} {}",
            exe.display(),
            args,
            out.status,
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

pub fn sc(args: &[String]) -> io::Result<()> {
    run_exe(sys32("sc.exe"), args)
}

/// Make `dir` writable by SYSTEM only (Administrators read/execute, no Users access).
pub fn lock_down_dir(dir: &str) -> io::Result<()> {
    run_exe(sys32("icacls.exe"), &service_logic::icacls_lockdown_args(dir))
}

/// Create the state directory and ACL it. Idempotent; run at install and at every service start.
pub fn ensure_state_dir() -> io::Result<()> {
    let dir = state_dir();
    std::fs::create_dir_all(&dir)?;
    lock_down_dir(&dir.to_string_lossy())
}

/// Wall-clock milliseconds since the Unix epoch.
pub fn wall_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
