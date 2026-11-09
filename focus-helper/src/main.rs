//! `focus-helper` binary: portable `stdio` mode, plus the Windows install/uninstall/service/watchdog modes.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use focus_helper::daemon::{Daemon, Platform};
use focus_helper::enforce::{Proc, ProcessTable};

const USAGE: &str = "usage: focus-helper stdio --state <path> | install | uninstall [--purge-state] | service | watchdog | send <json-request | ->";

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

enum Cmd {
    Install,
    Uninstall {
        #[cfg_attr(not(windows), allow(dead_code))]
        purge: bool,
    },
}

#[cfg(windows)]
fn windows_cmd(cmd: Cmd) -> ExitCode {
    use focus_helper::win::install;
    let result = match cmd {
        Cmd::Install => install::install(),
        Cmd::Uninstall { purge } => install::uninstall(purge),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            focus_helper::win::log::install_log(&format!("exit code {}: {}", e.exit_code(), e.message()));
            eprintln!("focus-helper: {}", e.message());
            eprintln!("focus-helper: details are also in {}", std::env::temp_dir().join(focus_helper::service_logic::INSTALL_LOG_FILE).display());
            ExitCode::from(e.exit_code())
        }
    }
}

#[cfg(not(windows))]
fn windows_cmd(_cmd: Cmd) -> ExitCode {
    eprintln!("Windows only");
    ExitCode::from(2)
}

/// `send`: one JSON request (argument, or `-` for one line from stdin) to the service pipe; prints
/// the single JSON reply. Exit 0 whenever a reply arrived (even an Error reply), 1 on transport failure.
#[cfg(windows)]
fn send(arg: &str) -> ExitCode {
    let request = if arg == "-" {
        let mut line = String::new();
        if io::stdin().lock().read_line(&mut line).is_err() || line.trim().is_empty() {
            eprintln!("focus-helper: no request on stdin");
            return ExitCode::from(1);
        }
        line
    } else {
        arg.to_string()
    };
    match focus_helper::win::client::send(&request) {
        Ok(reply) => {
            println!("{reply}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("focus-helper: {e}");
            ExitCode::from(1)
        }
    }
}

#[cfg(not(windows))]
fn send(_arg: &str) -> ExitCode {
    eprintln!("Windows only");
    ExitCode::from(2)
}

#[cfg(windows)]
fn windows_service_main(role: focus_helper::service_logic::Role) -> ExitCode {
    match focus_helper::win::service::run(role) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("focus-helper: cannot start as a service: {e}");
            ExitCode::from(1)
        }
    }
}

#[cfg(not(windows))]
fn windows_service_main(_role: focus_helper::service_logic::Role) -> ExitCode {
    eprintln!("Windows only");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["stdio", "--state", path] => stdio(PathBuf::from(path)),
        ["install"] => windows_cmd(Cmd::Install),
        ["uninstall"] => windows_cmd(Cmd::Uninstall { purge: false }),
        ["uninstall", "--purge-state"] => windows_cmd(Cmd::Uninstall { purge: true }),
        ["service"] => windows_service_main(focus_helper::service_logic::Role::Main),
        ["watchdog"] => windows_service_main(focus_helper::service_logic::Role::Watchdog),
        ["send", request] => send(request),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
