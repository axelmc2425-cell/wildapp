//! `install` and `uninstall` commands. Windows only; run elevated.
//!
//! Friction, not a guarantee: an Administrator can still take ownership of a service or the
//! install directory and change the ACLs. The restrictive descriptors only stop casual attempts.
//! For the same reason install/uninstall, once their lock check has passed, temporarily widen
//! the service descriptor to let the elevated Administrator running them stop and delete the
//! services; every error path restores the restrictive state (`restore`).
//!
//! Exit codes (see installer-hooks.nsh): 0 ok, 1 refused (a pending lock, or no uninstall permit when
//! a helper service exists: an upgrade over a running helper and any uninstall of an installed one
//! need a permit), 3 failure.

use std::path::{Path, PathBuf};
use std::time::Duration;

use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_ALL_ACCESS};
use winreg::RegKey;

use windows_service::service::ServiceState;

use crate::lockstore::LockStore;
use crate::persist;
use crate::service_logic::{self as logic, CmdError, Role, SERVICE_SDDL, SERVICE_SDDL_ADMIN_MANAGE};
use crate::win::log::{install_log, log};

/// Install/uninstall steps go to the service log and to the temp-dir install log.
fn ilog(msg: &str) {
    log(msg);
    install_log(msg);
}
use crate::win::{paths, procs, scm};

const STOP_TIMEOUT: Duration = Duration::from_secs(30);
/// Watchdog first.
const STOP_ORDER: [Role; 2] = [Role::Watchdog, Role::Main];

fn load_store_and_now() -> (LockStore, i64) {
    let store = persist::load(&paths::state_file());
    let now = paths::wall_ms().max(store.high_water_ms);
    (store, now)
}

/// Loads the store, converts a due waiting period to a permit (saving the converted state so
/// the file agrees; best effort) and applies the uninstall gate (lock-pending first, then permit).
fn gate_now() -> (Result<(), String>, LockStore) {
    let (mut store, now) = load_store_and_now();
    let (verdict, changed) = logic::uninstall_gate_converting(&mut store, now);
    if changed {
        if let Err(e) = persist::save(&paths::state_file(), &store) {
            ilog(&format!("uninstall: cannot save the converted waiting period: {e}"));
        }
    }
    (verdict, store)
}

/// State kept after a successful removal: the used permit is cleared and saved (best effort;
/// the state directory is SYSTEM-owned, so write access is taken first unless it is a link).
fn clear_permit_after_removal() {
    let (mut store, _) = load_store_and_now();
    store.clear_permit();
    if !paths::state_dir_is_reparse() {
        admin_write(&paths::state_dir().to_string_lossy());
    }
    if let Err(e) = persist::save(&paths::state_file(), &store) {
        ilog(&format!("uninstall: cannot clear the used permit: {e}"));
    }
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

/// Best-effort return of ONE service to the protected state. Every step is attempted regardless
/// of earlier failures (including a transient SCM query error): widen, `start= auto`, start,
/// restrictive descriptor.
fn restore_service(role: Role) {
    sc_widen(role);
    if let Err(e) = paths::sc(&logic::sc_config_start_args(role, "auto")) {
        ilog(&format!("restore: {e}"));
    }
    if let Err(e) = scm::start_if_stopped(role) {
        ilog(&format!("restore: cannot start {}: {e}", role.service_name()));
    }
    if let Err(e) = paths::sc(&logic::sc_sdset_args(role, SERVICE_SDDL)) {
        ilog(&format!("restore: {e}"));
    }
}

/// Best-effort return to the protected state after a failure: BOTH services are set to auto-start,
/// started and given the restrictive descriptor (unconditionally), and the install directory is
/// locked down again. The state directory is NOT touched: as an Administrator we cannot re-ACL a
/// SYSTEM-owned directory, and the service re-asserts it at every start.
///
/// Known limit: if this process is killed between `start= disabled` and `start= auto`,
/// enforcement stays off until the next `install` (which recovers, see `install`).
fn restore() {
    for role in [Role::Main, Role::Watchdog] {
        restore_service(role);
    }
    let dir = paths::install_dir();
    if Path::new(&dir).exists() {
        let _ = paths::lock_down_dir(&dir);
    }
}

pub fn install() -> Result<(), CmdError> {
    if let Err(e) = paths::ensure_state_dir_for_install() {
        return Err(failed(format!("cannot prepare state directory: {e}")));
    }
    let existing = existing_services()?;
    for (role, st) in &existing {
        if *st == ServiceState::Stopped && matches!(scm::is_disabled(*role), Ok(Some(true))) {
            // Left over from an interrupted install/uninstall: proceeding re-enables it.
            ilog(&format!("install: recovering {} (disabled and stopped)", role.service_name()));
        }
    }

    // An upgrade over a RUNNING helper stops it, and the service honours Stop only with a permit
    // (and no pending lock): refuse early with the how-to instead of timing out after 30 s. A first
    // install, or one where every service is stopped, needs neither.
    let any_running = existing.iter().any(|(_, st)| *st != ServiceState::Stopped);
    let needs_gate = logic::install_needs_gate(any_running);
    if needs_gate {
        if let (Err(why), _) = gate_now() {
            let msg = format!("install refused: the helper is running and {why}");
            ilog(&msg);
            return Err(CmdError::LockPending(msg));
        }
    }

    ilog("install: starting");
    let result = mutate(&existing, needs_gate);
    if let Err(e) = &result {
        ilog(&format!("install failed: {e}; restoring protected state"));
        restore();
        return Err(failed(e));
    }
    ilog("install: done");
    println!("installed {} and {}", Role::Main.service_name(), Role::Watchdog.service_name());
    Ok(())
}

fn mutate(existing: &[(Role, ServiceState)], used_permit: bool) -> Result<(), String> {
    let target_dir = paths::install_dir();
    let target_exe = paths::install_exe();

    // Stopped services (the only case when a lock is pending) are merely disabled; running ones
    // exist here only when no lock is pending.
    disable_and_stop(existing)?;
    if used_permit {
        // The permit did its job: drop it while the services are down, so the new helper starts
        // protected and the upgrade leaves no open uninstall window behind.
        clear_permit_after_removal();
    }
    // Running samplers hold the installed exe open; stop them so it can be replaced.
    stop_samplers_for(&target_exe);

    // Copy our own exe to the admin-only Program Files location; services run THAT copy, never
    // a per-user directory (a SYSTEM service on a user-writable exe would be an escalation hole).
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("cannot create {target_dir}: {e}"))?;
    admin_write(&target_dir); // an earlier install left it SYSTEM-write-only
    let me = std::env::current_exe().map_err(|e| format!("cannot find own exe: {e}"))?;
    if !same_file(&me, Path::new(&target_exe)) {
        copy_atomically(&me, &target_exe)?;
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
    // Last step, so a failed install leaves no Run value: the sampler runs the installed copy
    // in each user's session from the next sign-in on.
    set_sampler_run(&target_exe)?;
    Ok(())
}

fn stop_samplers_for(exe: &str) {
    let n = procs::stop_samplers(exe);
    if n > 0 {
        ilog(&format!("stopped {n} running sampler process(es)"));
    }
}

/// Registers the per-user sampler to start at every sign-in (idempotent: overwrites the value).
fn set_sampler_run(exe: &str) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .create_subkey(logic::RUN_KEY_PATH)
        .map_err(|e| format!("cannot open the Run key: {e}"))?;
    key.set_value(logic::SAMPLER_RUN_VALUE, &logic::sampler_run_command(exe))
        .map_err(|e| format!("cannot write the sampler Run entry: {e}"))
}

/// Removes the sampler Run entry; an absent key or value is fine (idempotent).
fn remove_sampler_run() -> Result<(), String> {
    let key = match RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(logic::RUN_KEY_PATH, KEY_ALL_ACCESS) {
        Ok(k) => k,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("cannot open the Run key: {e}")),
    };
    match key.delete_value(logic::SAMPLER_RUN_VALUE) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove the sampler Run entry: {e}")),
    }
}

/// Copy to `<exe>.new`, verify the size, then rename over the installed exe. On any failure the
/// `.new` file is removed and the old exe is left untouched, so a truncated binary is never
/// registered. The temp file lives in the install dir (admin-only writable, locked down after).
fn copy_atomically(src: &Path, target_exe: &str) -> Result<(), String> {
    let tmp = logic::temp_exe_path(target_exe);
    let result = (|| -> Result<(), String> {
        let _ = std::fs::remove_file(&tmp);
        std::fs::copy(src, &tmp).map_err(|e| format!("cannot copy to {tmp}: {e}"))?;
        let want = std::fs::metadata(src).map_err(|e| e.to_string())?.len();
        let got = std::fs::metadata(&tmp).map_err(|e| e.to_string())?.len();
        if want != got {
            return Err(format!("copy verification failed: {got} bytes written, expected {want}"));
        }
        std::fs::OpenOptions::new()
            .write(true)
            .open(&tmp)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("cannot flush {tmp}: {e}"))?;
        std::fs::rename(&tmp, target_exe).map_err(|e| format!("cannot replace {target_exe}: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

pub fn uninstall(purge_state: bool) -> Result<(), CmdError> {
    let existing = existing_services()?;
    // With no helper service (failed install, manual recovery) there is nothing to protect and no
    // permit to ask for: skip the gate and just clean up.
    let needs_gate = logic::uninstall_needs_gate(existing.len());
    if needs_gate {
        let (verdict, _) = gate_now();
        verdict.map_err(|why| CmdError::LockPending(format!("uninstall refused: {why}")))?;
    }
    ilog("uninstall: starting");

    if let Err(e) = disable_and_stop(&existing) {
        ilog(&format!("uninstall: stop failed: {e}"));
        restore();
        return Err(failed(format!("could not stop the helper services; nothing was removed ({e})")));
    }

    // A lock may have been pushed while we were stopping; re-check right before deleting.
    if needs_gate {
        let (verdict, _) = gate_now();
        if let Err(why) = verdict {
            restore();
            return Err(CmdError::LockPending(format!("uninstall refused: {why}")));
        }
    }

    let mut problems = Vec::new();
    for (role, _) in &existing {
        if let Err(e) = paths::sc(&logic::sc_delete_args(*role)) {
            problems.push(e.to_string());
            // Still installed: put it back to auto-start and running rather than leave it disabled.
            restore_service(*role);
        }
    }

    // Only when every service is gone: if one was restored above, the sampler stays registered.
    if problems.is_empty() {
        if let Err(e) = remove_sampler_run() {
            problems.push(e);
        }
        // Samplers hold the exe open: stop them, only now that the services are gone.
        stop_samplers_for(&paths::install_exe());
    }

    // Best effort: our own exe may be running from here.
    let install_dir = paths::install_dir();
    admin_write(&install_dir);
    let _ = std::fs::remove_dir_all(&install_dir);

    if purge_state {
        let dir: PathBuf = paths::state_dir();
        let removed = if paths::state_dir_is_reparse() {
            // A junction/symlink: remove the link itself, never its target.
            std::fs::remove_dir(&dir)
        } else {
            admin_write(&dir.to_string_lossy());
            std::fs::remove_dir_all(&dir)
        };
        if let Err(e) = removed {
            if e.kind() != std::io::ErrorKind::NotFound {
                problems.push(format!("cannot remove {}: {e}", dir.display()));
            }
        }
    }

    if problems.is_empty() && !purge_state {
        clear_permit_after_removal();
    }

    if problems.is_empty() {
        ilog("uninstall: done");
        println!("uninstalled");
        Ok(())
    } else {
        let msg = problems.join("; ");
        ilog(&format!("uninstall: {msg}"));
        Err(failed(msg))
    }
}
