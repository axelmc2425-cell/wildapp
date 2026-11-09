//! `install` and `uninstall` commands. Windows only; run elevated.
//!
//! Friction, not a guarantee: an Administrator can still take ownership of a service or the
//! install directory and change the ACLs. The restrictive descriptors only stop casual attempts.
//! For the same reason install/uninstall, once their lock check has passed, temporarily widen
//! the service descriptor to let the elevated Administrator running them stop and delete the
//! services; every error path restores the restrictive state (`restore`).
//!
//! Exit codes (see installer-hooks.nsh): 0 ok, 1 refused because of a pending lock, 3 failure.

use std::path::{Path, PathBuf};
use std::time::Duration;

use windows_service::service::ServiceState;

use crate::lockstore::LockStore;
use crate::persist;
use crate::service_logic::{self as logic, CmdError, Role, SERVICE_SDDL, SERVICE_SDDL_ADMIN_MANAGE};
use crate::win::log::log;
use crate::win::{paths, scm};

const STOP_TIMEOUT: Duration = Duration::from_secs(30);
/// Watchdog first.
const STOP_ORDER: [Role; 2] = [Role::Watchdog, Role::Main];

fn load_store_and_now() -> (LockStore, i64) {
    let store = persist::load(&paths::state_file());
    let now = paths::wall_ms().max(store.high_water_ms);
    (store, now)
}

fn failed(e: impl ToString) -> CmdError {
    CmdError::Failed(e.to_string())
}

fn sc_widen(role: Role) {
    // Best effort: fails harmlessly if the service does not exist or the descriptor is already wide.
    let _ = paths::sc(&logic::sc_sdset_args(role, SERVICE_SDDL_ADMIN_MANAGE));
}

fn admin_write(dir: &str) {
    // The owner (SYSTEM, when the service created it) may need to be taken first.
    let _ = paths::icacls(&logic::icacls_setowner_args(dir, logic::ADMINS_SID, false));
    let _ = paths::icacls(&logic::icacls_admin_write_args(dir));
}

fn existing_services() -> Result<Vec<(Role, ServiceState)>, CmdError> {
    let mut v = Vec::new();
    for role in STOP_ORDER {
        let state = scm::state_of(role).map_err(|e| failed(format!("cannot query {}: {e}", role.service_name())))?;
        if let Some(state) = state {
            v.push((role, state));
        }
    }
    Ok(v)
}

/// Disable both services (so the peer watchdog cannot revive one) and stop both. Does nothing
/// to services that are already stopped beyond disabling them.
fn disable_and_stop(existing: &[(Role, ServiceState)]) -> Result<(), String> {
    for (role, _) in existing {
        sc_widen(*role);
        paths::sc(&logic::sc_config_start_args(*role, "disabled")).map_err(|e| e.to_string())?;
    }
    for (role, _) in existing {
        scm::stop_and_wait(*role, STOP_TIMEOUT).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Best-effort return to the protected state after a failure: services auto-start again and
/// running, restrictive descriptor re-applied, install and state directories locked down.
fn restore() {
    for role in [Role::Main, Role::Watchdog] {
        if matches!(scm::state_of(role), Ok(Some(_))) {
            sc_widen(role);
            if let Err(e) = paths::sc(&logic::sc_config_start_args(role, "auto")) {
                log(&format!("restore: {e}"));
            }
            if let Err(e) = scm::start_if_stopped(role) {
                log(&format!("restore: cannot start {}: {e}", role.service_name()));
            }
            if let Err(e) = paths::sc(&logic::sc_sdset_args(role, SERVICE_SDDL)) {
                log(&format!("restore: {e}"));
            }
        }
    }
    let dir = paths::install_dir();
    if Path::new(&dir).exists() {
        let _ = paths::lock_down_dir(&dir);
    }
    let _ = paths::ensure_state_dir();
}

pub fn install() -> Result<(), CmdError> {
    match paths::ensure_state_dir() {
        Ok(Some(w)) => log(&w),
        Ok(None) => {}
        Err(e) => return Err(failed(format!("cannot prepare state directory: {e}"))),
    }
    let (store, now) = load_store_and_now();
    let lock = logic::uninstall_decision(&store.windows, now);
    let existing = existing_services()?;

    // Upgrade safety: never stop running services while a lock is pending.
    if let Err(why) = &lock {
        if existing.iter().any(|(_, st)| *st != ServiceState::Stopped) {
            let msg = format!("install refused: the helper is running and {why}");
            log(&msg);
            return Err(CmdError::LockPending(msg));
        }
    }

    log("install: starting");
    let result = mutate(&existing);
    if let Err(e) = &result {
        log(&format!("install failed: {e}; restoring protected state"));
        restore();
        return Err(failed(e));
    }
    log("install: done");
    println!("installed {} and {}", Role::Main.service_name(), Role::Watchdog.service_name());
    Ok(())
}

fn mutate(existing: &[(Role, ServiceState)]) -> Result<(), String> {
    let target_dir = paths::install_dir();
    let target_exe = paths::install_exe();

    // Stopped services (the only case when a lock is pending) are merely disabled; running ones
    // exist here only when no lock is pending.
    disable_and_stop(existing)?;

    // Copy our own exe to the admin-only Program Files location; services run THAT copy, never
    // a per-user directory (a SYSTEM service on a user-writable exe would be an escalation hole).
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("cannot create {target_dir}: {e}"))?;
    admin_write(&target_dir); // an earlier install left it SYSTEM-write-only
    let me = std::env::current_exe().map_err(|e| format!("cannot find own exe: {e}"))?;
    if !same_file(&me, Path::new(&target_exe)) {
        std::fs::copy(&me, &target_exe).map_err(|e| format!("cannot copy to {target_exe}: {e}"))?;
    }
    paths::lock_down_dir(&target_dir).map_err(|e| format!("cannot restrict {target_dir}: {e}"))?;

    for role in [Role::Main, Role::Watchdog] {
        if existing.iter().any(|(r, _)| *r == role) {
            // `config` also sets start= auto again, undoing the temporary disable.
            paths::sc(&logic::sc_config_args(role, &target_exe)).map_err(|e| e.to_string())?;
        } else {
            paths::sc(&logic::sc_create_args(role, &target_exe)).map_err(|e| e.to_string())?;
        }
        paths::sc(&logic::sc_failure_args(role)).map_err(|e| e.to_string())?;
        paths::sc(&logic::sc_failureflag_args(role)).map_err(|e| e.to_string())?;
    }
    // Start while the descriptor still lets us, then restrict it.
    for role in [Role::Main, Role::Watchdog] {
        scm::start_if_stopped(role).map_err(|e| format!("cannot start {}: {e}", role.service_name()))?;
    }
    for role in [Role::Main, Role::Watchdog] {
        paths::sc(&logic::sc_sdset_args(role, SERVICE_SDDL)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

pub fn uninstall(purge_state: bool) -> Result<(), CmdError> {
    let (store, now) = load_store_and_now();
    logic::uninstall_decision(&store.windows, now)
        .map_err(|why| CmdError::LockPending(format!("uninstall refused: {why}")))?;
    let existing = existing_services()?;
    log("uninstall: starting");

    if let Err(e) = disable_and_stop(&existing) {
        log(&format!("uninstall: stop failed: {e}"));
        restore();
        return Err(failed(format!("could not stop the helper services; nothing was removed ({e})")));
    }

    // A lock may have been pushed while we were stopping; re-check right before deleting.
    let (store, now) = load_store_and_now();
    if let Err(why) = logic::uninstall_decision(&store.windows, now) {
        restore();
        return Err(CmdError::LockPending(format!("uninstall refused: {why}")));
    }

    let mut problems = Vec::new();
    for (role, _) in &existing {
        if let Err(e) = paths::sc(&logic::sc_delete_args(*role)) {
            problems.push(e.to_string());
        }
    }

    // Best effort: our own exe may be running from here.
    let install_dir = paths::install_dir();
    admin_write(&install_dir);
    let _ = std::fs::remove_dir_all(&install_dir);

    if purge_state {
        let dir: PathBuf = paths::state_dir();
        admin_write(&dir.to_string_lossy());
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                problems.push(format!("cannot remove {}: {e}", dir.display()));
            }
        }
    }

    if problems.is_empty() {
        log("uninstall: done");
        println!("uninstalled");
        Ok(())
    } else {
        let msg = problems.join("; ");
        log(&format!("uninstall: {msg}"));
        Err(failed(msg))
    }
}
