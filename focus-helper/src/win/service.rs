//! Service entry points: `service` (the enforcement daemon) and `watchdog`. Windows only.
//!
//! Control handler rules: Shutdown is always honored. Stop is honored only while no locked or
//! frozen window is pending (active or scheduled, `ends > now`); otherwise it is ignored and the service stays Running. The daemon
//! loop refreshes `Flags::stop_allowed` from the store and the effective clock every tick.
//! Each service also checks the other every 5 s through the SCM and starts it if Stopped.

use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult, ServiceStatusHandle};
use windows_service::{define_windows_service, service_dispatcher};

use crate::persist;
use crate::service_logic::{self, Role};
use crate::win::log::log;
use crate::win::{paths, pipe, scm};

pub const PEER_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// State shared between the SCM control handler thread and the service loop.
pub struct Flags {
    pub stop_requested: AtomicBool,
    /// True while no locked/frozen window is pending. Starts false so a Stop arriving before
    /// the first tick is ignored rather than honored blindly.
    pub stop_allowed: AtomicBool,
}

impl Flags {
    fn new() -> Arc<Flags> {
        Arc::new(Flags { stop_requested: AtomicBool::new(false), stop_allowed: AtomicBool::new(false) })
    }
}

static ROLE: OnceLock<Role> = OnceLock::new();

define_windows_service!(ffi_service_main, service_main);

/// Hand the process to the SCM dispatcher. Blocks until the service has stopped.
pub fn run(role: Role) -> Result<(), windows_service::Error> {
    let _ = ROLE.set(role);
    service_dispatcher::start(role.service_name(), ffi_service_main)
}

fn service_main(_args: Vec<OsString>) {
    let role = *ROLE.get().expect("role set before dispatch");
    if let Err(e) = run_service(role) {
        log(&format!("{}: {e}", role.arg()));
    }
}

fn report(handle: &ServiceStatusHandle, state: ServiceState, accept: ServiceControlAccept, exit: u32) {
    let _ = handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accept,
        exit_code: ServiceExitCode::Win32(exit),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    });
}

fn run_service(role: Role) -> windows_service::Result<()> {
    let flags = Flags::new();
    let handler_flags = flags.clone();
    let handle = service_control_handler::register(role.service_name(), move |event| match event {
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        ServiceControl::Shutdown => {
            handler_flags.stop_requested.store(true, Ordering::SeqCst);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Stop => {
            if handler_flags.stop_allowed.load(Ordering::SeqCst) {
                handler_flags.stop_requested.store(true, Ordering::SeqCst);
            }
            // Ignored while a lock is active: status stays Running.
            ServiceControlHandlerResult::NoError
        }
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;

    let accept = ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN;
    report(&handle, ServiceState::Running, accept, 0);

    let result = match role {
        Role::Main => run_main(&flags),
        Role::Watchdog => run_watchdog(&flags),
    };
    let code = match &result {
        Ok(()) => 0,
        Err(e) => {
            log(&format!("{}: {e}", role.arg()));
            1
        }
    };
    report(&handle, ServiceState::Stopped, ServiceControlAccept::empty(), code);
    Ok(())
}

fn run_main(flags: &Arc<Flags>) -> std::io::Result<()> {
    if let Some(warning) = paths::ensure_state_dir()? {
        log(&warning);
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, pipe::serve(paths::state_file(), flags.clone()))
}

/// Sleep up to `total`, waking early when stop is requested.
pub fn sleep_unless_stopped(flags: &Flags, total: Duration) {
    let step = Duration::from_millis(250);
    let mut slept = Duration::ZERO;
    while slept < total && !flags.stop_requested.load(Ordering::SeqCst) {
        std::thread::sleep(step);
        slept += step;
    }
}

fn run_watchdog(flags: &Arc<Flags>) -> std::io::Result<()> {
    let state_path = paths::state_file();
    while !flags.stop_requested.load(Ordering::SeqCst) {
        // The watchdog has no clock of its own: it reads the persisted store and takes the later
        // of the wall clock and the persisted high-water mark.
        let store = persist::load(&state_path);
        let now = paths::wall_ms().max(store.high_water_ms);
        flags.stop_allowed.store(service_logic::stop_allowed(&store.windows, now), Ordering::SeqCst);
        if let Err(e) = scm::start_if_stopped(Role::Watchdog.other()) {
            log(&format!("watchdog: cannot check {}: {e}", Role::Main.service_name()));
        }
        sleep_unless_stopped(flags, PEER_CHECK_INTERVAL);
    }
    Ok(())
}
