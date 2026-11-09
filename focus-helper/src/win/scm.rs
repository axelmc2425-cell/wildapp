//! Service Control Manager helpers (windows-service crate). Windows only.

use std::io;
use std::time::{Duration, Instant};

use windows_service::service::{ServiceAccess, ServiceState};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::Error;

use crate::service_logic::Role;

const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;
const ERROR_SERVICE_NOT_ACTIVE: i32 = 1062;

fn win32(e: &Error) -> Option<i32> {
    match e {
        Error::Winapi(io) => io.raw_os_error(),
        _ => None,
    }
}

fn to_io(e: Error) -> io::Error {
    io::Error::other(e.to_string())
}

fn manager() -> Result<ServiceManager, Error> {
    ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
}

/// `Ok(None)` when the service is not installed.
pub fn state_of(role: Role) -> io::Result<Option<ServiceState>> {
    let mgr = manager().map_err(to_io)?;
    match mgr.open_service(role.service_name(), ServiceAccess::QUERY_STATUS) {
        Ok(svc) => Ok(Some(svc.query_status().map_err(to_io)?.current_state)),
        Err(e) if win32(&e) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => Ok(None),
        Err(e) => Err(to_io(e)),
    }
}

/// Start the service if (and only if) it is found Stopped. Used by the mutual watchdog.
pub fn start_if_stopped(role: Role) -> io::Result<()> {
    let mgr = manager().map_err(to_io)?;
    let svc = mgr
        .open_service(role.service_name(), ServiceAccess::QUERY_STATUS | ServiceAccess::START)
        .map_err(to_io)?;
    if svc.query_status().map_err(to_io)?.current_state == ServiceState::Stopped {
        match svc.start::<&str>(&[]) {
            Ok(()) => {}
            Err(e) if win32(&e) == Some(ERROR_SERVICE_ALREADY_RUNNING) => {}
            Err(e) => return Err(to_io(e)),
        }
    }
    Ok(())
}

/// Ask the service to stop and wait until it is Stopped. Not installed or already stopped is Ok.
pub fn stop_and_wait(role: Role, timeout: Duration) -> io::Result<()> {
    let mgr = manager().map_err(to_io)?;
    let svc = match mgr.open_service(role.service_name(), ServiceAccess::QUERY_STATUS | ServiceAccess::STOP) {
        Ok(s) => s,
        Err(e) if win32(&e) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => return Ok(()),
        Err(e) => return Err(to_io(e)),
    };
    match svc.stop() {
        Ok(_) => {}
        Err(e) if win32(&e) == Some(ERROR_SERVICE_NOT_ACTIVE) => return Ok(()),
        Err(e) => return Err(to_io(e)),
    }
    let deadline = Instant::now() + timeout;
    loop {
        if svc.query_status().map_err(to_io)?.current_state == ServiceState::Stopped {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other(format!(
                "{} did not stop in time (it may be refusing Stop because a lock is active)",
                role.service_name()
            )));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
