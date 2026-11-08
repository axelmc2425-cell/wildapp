//! `focus-helper` binary. Portable `stdio` mode here; Windows service modes arrive in Task 12b.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use focus_helper::daemon::{Daemon, Platform};
use focus_helper::enforce::{Proc, ProcessTable};

const USAGE: &str = "usage: focus-helper stdio --state <path> | install | uninstall | service | watchdog";

struct EmptyTable;
impl ProcessTable for EmptyTable {
    fn list(&self) -> Vec<Proc> {
        Vec::new()
    }
    fn kill(&self, _pid: u32) -> bool {
        false
    }
}

struct NullPlatform;
impl Platform for NullPlatform {
    fn enforce_hosts(&mut self, _sites: &[String]) -> io::Result<bool> {
        Ok(false)
    }
    fn set_doh_off(&mut self) -> io::Result<Vec<String>> {
        Ok(Vec::new())
    }
    fn clear_doh_off(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn flush_dns(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn process_table(&self) -> &dyn ProcessTable {
        &EmptyTable
    }
}

fn wall_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn nonce(counter: u64) -> [u8; 16] {
    let state = RandomState::new();
    let mut out = [0u8; 16];
    for (i, chunk) in out.chunks_mut(8).enumerate() {
        let mut h = state.build_hasher();
        h.write_u64(counter);
        h.write_u64(i as u64);
        h.write_i64(wall_ms());
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    out
}

fn stdio(state: PathBuf) -> ExitCode {
    let mut daemon = Daemon::load(&state);
    let mut platform = NullPlatform;
    let start = Instant::now();
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut counter = 0u64;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        counter += 1;
        let mono = start.elapsed().as_millis() as i64;
        let reply = daemon.handle_line(&line, wall_ms(), mono, nonce(counter), &mut platform);
        if writeln!(stdout, "{reply}").and_then(|_| stdout.flush()).is_err() {
            break;
        }
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["stdio", "--state", path] => stdio(PathBuf::from(path)),
        ["install"] | ["uninstall"] | ["service"] | ["watchdog"] => {
            #[cfg(windows)]
            eprintln!("not implemented yet (Task 12b)");
            #[cfg(not(windows))]
            eprintln!("Windows only");
            ExitCode::from(2)
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
