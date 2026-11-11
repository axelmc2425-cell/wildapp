//! Named-pipe server and the main daemon loop. Windows only.
//!
//! One current-thread runtime: a 1 s interval calls `Daemon::tick`, a 5 s interval checks the
//! watchdog service, and each pipe client is a local task sharing the daemon. The daemon is only
//! borrowed synchronously (never across an await), so a `RefCell` suffices.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::io;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::time::{interval, timeout, MissedTickBehavior};

use crate::daemon::Daemon;
use crate::service_logic::{pipe_retry_delay_ms, Role, PIPE_NAME, PIPE_SDDL};
use crate::win::log::log;
use crate::win::platform::{os_nonce, WindowsPlatform};
use crate::win::service::{Flags, PEER_CHECK_INTERVAL};
use crate::win::{paths, scm};

const MAX_LINE: u64 = 4 * 1024 * 1024;
const MAX_CLIENTS: usize = 16;
const IDLE: Duration = Duration::from_secs(10);

struct Shared {
    daemon: Daemon,
    platform: WindowsPlatform,
}

struct CountGuard(Rc<Cell<usize>>);
impl Drop for CountGuard {
    fn drop(&mut self) {
        self.0.set(self.0.get().saturating_sub(1));
    }
}

/// Create one pipe instance with the explicit DACL from `PIPE_SDDL` (the default DACL would give
/// Everyone read-only access, so a normal user's app could not send requests; the explicit user
/// ACE omits FILE_CREATE_PIPE_INSTANCE so users cannot create instances).
fn create_server(first: bool) -> io::Result<NamedPipeServer> {
    paths::with_security_attributes(PIPE_SDDL, |attrs| {
        // SAFETY: `attrs` is a valid SECURITY_ATTRIBUTES that outlives the call.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(PIPE_NAME, attrs as *mut c_void)
        }
    })?
}

/// Try to (re)create the listening instance; on failure log and schedule a backoff retry. The
/// daemon never stops because of this: the tick loop keeps enforcing.
fn refill(server: &mut Option<NamedPipeServer>, attempt: &mut u32, retry_at: &mut tokio::time::Instant) {
    match create_server(false) {
        Ok(s) => {
            *server = Some(s);
            *attempt = 0;
        }
        Err(e) => {
            let delay = pipe_retry_delay_ms(*attempt);
            log(&format!("pipe: cannot create instance ({e}); retrying in {delay} ms"));
            *attempt = attempt.saturating_add(1);
            *retry_at = tokio::time::Instant::now() + Duration::from_millis(delay);
        }
    }
}

fn mono_ms(start: Instant) -> i64 {
    start.elapsed().as_millis() as i64
}

/// Run the daemon until stop is requested. Returns an error if the pipe cannot be created
/// (for example another process already owns the name); the SCM then restarts the service.
pub async fn serve(state_path: PathBuf, flags: Arc<Flags>) -> io::Result<()> {
    let shared = Rc::new(RefCell::new(Shared { daemon: Daemon::load_with_usage(&state_path, &paths::usage_file()), platform: WindowsPlatform::new() }));
    let start = Instant::now();
    let clients = Rc::new(Cell::new(0usize));
    // Only the very first instance may fail the service (someone else owns the name).
    let mut server = Some(create_server(true)?);
    let mut attempt = 0u32;
    let mut retry_at = tokio::time::Instant::now();
    let mut last_persist_warning: Option<String> = None;

    let mut tick = interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut peer = interval(PEER_CHECK_INTERVAL);
    peer.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            connected = async { server.as_mut().expect("guarded").connect().await }, if server.is_some() => {
                let client = server.take().expect("guarded");
                refill(&mut server, &mut attempt, &mut retry_at);
                if connected.is_ok() && clients.get() < MAX_CLIENTS {
                    clients.set(clients.get() + 1);
                    tokio::task::spawn_local(handle_client(client, shared.clone(), start, flags.clone(), CountGuard(clients.clone())));
                }
            }
            _ = tokio::time::sleep_until(retry_at), if server.is_none() => {
                refill(&mut server, &mut attempt, &mut retry_at);
            }
            _ = tick.tick() => {
                let mut s = shared.borrow_mut();
                let Shared { daemon, platform } = &mut *s;
                let (wall, mono) = (paths::wall_ms(), mono_ms(start));
                daemon.tick(wall, mono, platform);
                flags.stop_allowed.store(daemon.stop_allowed(wall, mono), Ordering::SeqCst);
                let persist_warning = daemon.warnings().into_iter().find(|w| w.starts_with("persist:"));
                if persist_warning != last_persist_warning {
                    if let Some(w) = &persist_warning {
                        log(w);
                    }
                    last_persist_warning = persist_warning;
                }
                if flags.stop_requested.load(Ordering::SeqCst) {
                    daemon.flush_usage();
                    return Ok(());
                }
            }
            _ = peer.tick() => {
                if let Err(e) = scm::start_if_stopped(Role::Main.other()) {
                    log(&format!("cannot check {}: {e}", Role::Watchdog.service_name()));
                }
            }
        }
    }
}

const RNG_ERROR: &str = r#"{"type":"Error","code":"bad-request","message":"os rng unavailable"}"#;

async fn handle_client(client: NamedPipeServer, shared: Rc<RefCell<Shared>>, start: Instant, flags: Arc<Flags>, _guard: CountGuard) {
    let (reader, mut writer) = tokio::io::split(client);
    let mut reader = BufReader::new(reader);
    loop {
        let mut line = Vec::new();
        let read = timeout(IDLE, (&mut reader).take(MAX_LINE).read_until(b'\n', &mut line)).await;
        match read {
            Ok(Ok(n)) if n > 0 => {}
            _ => break,
        }
        let complete = line.last() == Some(&b'\n');
        let text = String::from_utf8_lossy(&line).trim().to_string();
        let too_long = !complete && line.len() as u64 >= MAX_LINE;
        let reply = if too_long {
            r#"{"type":"Error","code":"bad-request","message":"request too long"}"#.to_string()
        } else if text.is_empty() {
            continue;
        } else {
            match os_nonce() {
                Ok(nonce) => {
                    let mut s = shared.borrow_mut();
                    let Shared { daemon, platform } = &mut *s;
                    let (wall, mono) = (paths::wall_ms(), mono_ms(start));
                    let reply = daemon.handle_line(&text, wall, mono, nonce, platform);
                    // Refresh right away so a Stop arriving before the next tick sees a new lock.
                    flags.stop_allowed.store(daemon.stop_allowed(wall, mono), Ordering::SeqCst);
                    reply
                }
                Err(e) => {
                    log(&e.to_string());
                    RNG_ERROR.to_string()
                }
            }
        };
        let write = async {
            writer.write_all(reply.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await
        };
        if !matches!(timeout(IDLE, write).await, Ok(Ok(()))) || too_long || !complete {
            break;
        }
    }
}
