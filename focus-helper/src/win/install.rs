//! `install` and `uninstall` commands. Windows only; run elevated.
//!
//! Friction, not a guarantee: an Administrator can still take ownership of a service or the
//! install directory and change the ACLs. The restrictive descriptors only stop casual attempts.
//! For the same reason install/uninstall, once their lock check has passed, temporarily widen
//! the service descriptor to let the elevated Administrator running them stop and delete the
//! services, then restore the restrictive one.

use std::path::{Path, PathBuf};
use std::time::Duration;

use windows_service::service::ServiceState;

use crate::lockstore::LockStore;
use crate::persist;
use crate::service_logic::{self as logic, Role, SERVICE_SDDL, SERVICE_SDDL_ADMIN_MANAGE};
use crate::win::dns::sys32;
use crate::win::{paths, scm};

const STOP_TIMEOUT: Duration = Duration::from_secs(30);
/// Watchdog first: otherwise it would restart the main service while we stop it.
const STOP_ORDER: [Role; 2] = [Role::Watchdog, Role::Main];

fn load_store_and_now() -> (LockStore, i64) {
    let store = persist::load(&paths::state_file());
    let now = paths::wall_ms().max(store.high_water_ms);
    (store, now)
}

fn sc_widen(role: Role) {
    // Best effort: fails harmlessly if the service does not exist or the descriptor is already wide.
    let _ = paths::sc(&logic::sc_sdset_args(role, SERVICE_SDDL_ADMIN_MANAGE));
}

fn admin_write(dir: &str) {
    let _ = paths::run_exe(sys32("icacls.exe"), &logic::icacls_admin_write_args(dir));
}

pub fn install() -> Result<(), String> {
    let pf = paths::program_files();
    let target_dir = logic::install_dir(&pf);
    let target_exe = logic::install_exe(&pf);

    paths::ensure_state_dir().map_err(|e| format!("cannot prepare state directory: {e}"))?;
    let (store, now) = load_store_and_now();
    let lock = logic::uninstall_decision(&store.windows, now);

    let mut existing = Vec::new();
    for role in STOP_ORDER {
        let state = scm::state_of(role).map_err(|e| format!("cannot query {}: {e}", role.service_name()))?;
        if let Some(state) = state {
            existing.push((role, state));
        }
    }

    // Upgrade safety: never stop running services while a lock is pending.
    if let Err(why) = &lock {
        if existing.iter().any(|(_, st)| *st != ServiceState::Stopped) {
            return Err(format!("install refused: the helper is running and {why}"));
        }
    } else {
        for (role, st) in &existing {
            if *st != ServiceState::Stopped {
                sc_widen(*role);
                scm::stop_and_wait(*role, STOP_TIMEOUT).map_err(|e| e.to_string())?;
            }
        }
    }

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
        let present = existing.iter().any(|(r, _)| *r == role);
        if present {
            sc_widen(role);
            paths::sc(&logic::sc_config_args(role, &target_exe)).map_err(|e| e.to_string())?;
        } else {
            paths::sc(&logic::sc_create_args(role, &target_exe)).map_err(|e| e.to_string())?;
        }
        paths::sc(&logic::sc_failure_args(role)).map_err(|e| e.to_string())?;
    }
    // Start while the descriptor still lets us, then restrict it.
    for role in [Role::Main, Role::Watchdog] {
        scm::start_if_stopped(role).map_err(|e| format!("cannot start {}: {e}", role.service_name()))?;
    }
    for role in [Role::Main, Role::Watchdog] {
        paths::sc(&logic::sc_sdset_args(role, SERVICE_SDDL)).map_err(|e| e.to_string())?;
    }
    println!("installed {} and {} from {target_exe}", Role::Main.service_name(), Role::Watchdog.service_name());
    Ok(())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

pub fn uninstall(purge_state: bool) -> Result<(), String> {
    let (store, now) = load_store_and_now();
    logic::uninstall_decision(&store.windows, now).map_err(|why| format!("uninstall refused: {why}"))?;

    let mut problems = Vec::new();
    for role in STOP_ORDER {
        match scm::state_of(role) {
            Ok(None) => continue,
            Ok(Some(_)) => {}
            Err(e) => {
                problems.push(format!("cannot query {}: {e}", role.service_name()));
                continue;
            }
        }
        sc_widen(role);
        if let Err(e) = scm::stop_and_wait(role, STOP_TIMEOUT) {
            problems.push(e.to_string());
        }
        if let Err(e) = paths::sc(&logic::sc_delete_args(role)) {
            problems.push(e.to_string());
        }
    }

    // Best effort: our own exe may be running from here.
    let install_dir = logic::install_dir(&paths::program_files());
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
        println!("uninstalled");
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}
