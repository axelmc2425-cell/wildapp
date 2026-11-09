//! Portable logic for the Windows service layer: names, paths, security descriptors, command
//! lines and the lock predicates that gate stop/uninstall/upgrade. Plain functions so they are
//! unit tested on any OS; the `win` glue only executes what is built here.
//!
//! Security note: everything here is friction, not a guarantee. An Administrator can still take
//! ownership of a service or directory, change its ACL, boot another OS, and so on.

use std::path::PathBuf;

use crate::model::{Lock, Window};

pub const MAIN_SERVICE: &str = "MyBrainFocus";
pub const WATCHDOG_SERVICE: &str = "MyBrainFocusWatchdog";
pub const PIPE_NAME: &str = r"\\.\pipe\mybrain-focus";
pub const DIR_NAME: &str = "MyBrainFocus";
pub const EXE_NAME: &str = "focus-helper.exe";
pub const STATE_FILE: &str = "state.json";

/// Pipe DACL: SYSTEM and Administrators full control, authenticated users read+write (a normal
/// user's MyBrain app must be able to send requests; the default DACL would give Everyone read only).
pub const PIPE_SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)";

/// Service DACL: SYSTEM full control; Administrators may only query config/status, interrogate,
/// enumerate dependents and read the descriptor (`CCLCSWLOCRRC`). Nobody else can start, stop,
/// reconfigure or delete it. The owner is not set, so an Administrator can still take ownership
/// or change the ACL (the install/uninstall paths below do exactly that once no lock is active).
pub const SERVICE_SDDL: &str = "D:(A;;GA;;;SY)(A;;CCLCSWLOCRRC;;;BA)";

/// Temporary DACL used by install/uninstall, only while no lock is pending, to let the
/// Administrator running them stop and delete the services.
pub const SERVICE_SDDL_ADMIN_MANAGE: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Main,
    Watchdog,
}

impl Role {
    pub fn service_name(self) -> &'static str {
        match self {
            Role::Main => MAIN_SERVICE,
            Role::Watchdog => WATCHDOG_SERVICE,
        }
    }
    /// CLI argument the service binary is registered with.
    pub fn arg(self) -> &'static str {
        match self {
            Role::Main => "service",
            Role::Watchdog => "watchdog",
        }
    }
    pub fn display_name(self) -> &'static str {
        match self {
            Role::Main => "MyBrain Focus Room Helper",
            Role::Watchdog => "MyBrain Focus Room Watchdog",
        }
    }
    pub fn other(self) -> Role {
        match self {
            Role::Main => Role::Watchdog,
            Role::Watchdog => Role::Main,
        }
    }
}

// ---- paths (Windows-style strings, built from environment values) ----

/// `%ProgramFiles%\MyBrainFocus`
pub fn install_dir(program_files: &str) -> String {
    format!(r"{}\{}", program_files.trim_end_matches('\\'), DIR_NAME)
}

/// `%ProgramFiles%\MyBrainFocus\focus-helper.exe`
pub fn install_exe(program_files: &str) -> String {
    format!(r"{}\{}", install_dir(program_files), EXE_NAME)
}

/// `%ProgramData%\MyBrainFocus`
pub fn state_dir(program_data: &str) -> String {
    format!(r"{}\{}", program_data.trim_end_matches('\\'), DIR_NAME)
}

pub fn state_file(program_data: &str) -> PathBuf {
    PathBuf::from(format!(r"{}\{}", state_dir(program_data), STATE_FILE))
}

/// `%SystemRoot%\System32\<exe>`: always an absolute path, never a PATH lookup.
pub fn system32_exe(system_root: &str, exe: &str) -> String {
    format!(r"{}\System32\{}", system_root.trim_end_matches('\\'), exe)
}

// ---- command lines ----

/// The service command line stored in the SCM: the quoted exe path plus the role argument.
pub fn bin_path(exe: &str, role: Role) -> String {
    format!("\"{}\" {}", exe, role.arg())
}

pub fn sc_create_args(role: Role, exe: &str) -> Vec<String> {
    vec![
        "create".into(),
        role.service_name().into(),
        "binPath=".into(),
        bin_path(exe, role),
        "start=".into(),
        "auto".into(),
        "obj=".into(),
        "LocalSystem".into(),
        "DisplayName=".into(),
        role.display_name().into(),
    ]
}

/// Used instead of `create` when the service already exists (upgrade).
pub fn sc_config_args(role: Role, exe: &str) -> Vec<String> {
    vec![
        "config".into(),
        role.service_name().into(),
        "binPath=".into(),
        bin_path(exe, role),
        "start=".into(),
        "auto".into(),
        "obj=".into(),
        "LocalSystem".into(),
        "DisplayName=".into(),
        role.display_name().into(),
    ]
}

pub fn sc_failure_args(role: Role) -> Vec<String> {
    vec![
        "failure".into(),
        role.service_name().into(),
        "reset=".into(),
        "60".into(),
        "actions=".into(),
        "restart/1000/restart/1000/restart/1000".into(),
    ]
}

pub fn sc_sdset_args(role: Role, sddl: &str) -> Vec<String> {
    vec!["sdset".into(), role.service_name().into(), sddl.into()]
}

pub fn sc_delete_args(role: Role) -> Vec<String> {
    vec!["delete".into(), role.service_name().into()]
}

/// icacls arguments that leave only SYSTEM (write) and Administrators (read/execute) on `dir`,
/// inherited by everything inside. No Users access.
pub fn icacls_lockdown_args(dir: &str) -> Vec<String> {
    vec![
        dir.into(),
        "/inheritance:r".into(),
        "/grant:r".into(),
        "*S-1-5-18:(OI)(CI)F".into(),
        "*S-1-5-32-544:(OI)(CI)RX".into(),
    ]
}

/// Temporarily lets Administrators write into a directory this module locked down, so an
/// upgrade or uninstall run by an elevated Administrator can replace or delete the files. Only
/// ever applied after the lock check passed; `icacls_lockdown_args` follows it.
pub fn icacls_admin_write_args(dir: &str) -> Vec<String> {
    vec![dir.into(), "/grant:r".into(), "*S-1-5-32-544:(OI)(CI)F".into()]
}

// ---- lock predicates ----

/// A locked or frozen window is in force right now. Gates the service Stop control: with an
/// active lock the helper ignores Stop (Shutdown is always honored).
pub fn lock_active(windows: &[Window], now_ms: i64) -> bool {
    windows.iter().any(|w| w.lock != Lock::None && w.starts <= now_ms && now_ms < w.ends)
}

/// Any locked or frozen window that has not ended yet (active or still to come).
pub fn lock_pending(windows: &[Window], now_ms: i64) -> bool {
    windows.iter().any(|w| w.lock != Lock::None && w.ends > now_ms)
}

pub fn stop_allowed(windows: &[Window], now_ms: i64) -> bool {
    !lock_active(windows, now_ms)
}

/// Gate for `uninstall` and for an upgrade that would stop the services: refused while any
/// locked/frozen window has `ends > now`. Returns the user-facing refusal message.
pub fn uninstall_decision(windows: &[Window], now_ms: i64) -> Result<(), String> {
    let latest = windows
        .iter()
        .filter(|w| w.lock != Lock::None && w.ends > now_ms)
        .map(|w| w.ends)
        .max();
    match latest {
        None => Ok(()),
        Some(ends) => Err(format!(
            "a locked or frozen focus window is still active or scheduled (latest ends at {ends} ms since the Unix epoch); \
             it cannot be removed until it ends or the partner unlocks it"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Mode;

    fn w(lock: Lock, starts: i64, ends: i64) -> Window {
        Window { id: "w".into(), starts, ends, lock, mode: Mode::Block, sites: vec![], apps: vec![] }
    }

    #[test]
    fn uninstall_refuses_with_active_lock_and_allows_otherwise() {
        assert!(uninstall_decision(&[w(Lock::Locked, 0, 100)], 50).is_err());
        assert!(uninstall_decision(&[w(Lock::Frozen, 0, 100)], 50).is_err());
        assert!(uninstall_decision(&[w(Lock::Locked, 200, 300)], 50).is_err(), "future lock counts");
        assert!(uninstall_decision(&[], 50).is_ok());
        assert!(uninstall_decision(&[w(Lock::None, 0, 100)], 50).is_ok(), "unlocked window");
        assert!(uninstall_decision(&[w(Lock::Locked, 0, 100)], 100).is_ok(), "ends == now is over");
        assert!(uninstall_decision(&[w(Lock::Locked, 0, 100)], 150).is_ok(), "expired");
    }

    #[test]
    fn stop_allowed_follows_active_locks() {
        assert!(stop_allowed(&[], 50));
        assert!(!stop_allowed(&[w(Lock::Locked, 0, 100)], 50));
        assert!(!stop_allowed(&[w(Lock::Frozen, 0, 100)], 99));
        assert!(stop_allowed(&[w(Lock::Locked, 0, 100)], 100));
        assert!(stop_allowed(&[w(Lock::Locked, 200, 300)], 50), "not started yet");
        assert!(stop_allowed(&[w(Lock::None, 0, 100)], 50));
    }

    #[test]
    fn pending_is_active_or_future() {
        assert!(lock_pending(&[w(Lock::Locked, 200, 300)], 50));
        assert!(!lock_pending(&[w(Lock::Locked, 0, 50)], 50));
    }

    #[test]
    fn paths() {
        assert_eq!(install_exe(r"C:\Program Files"), r"C:\Program Files\MyBrainFocus\focus-helper.exe");
        assert_eq!(install_dir(r"C:\Program Files\"), r"C:\Program Files\MyBrainFocus");
        assert_eq!(state_dir(r"C:\ProgramData"), r"C:\ProgramData\MyBrainFocus");
        assert_eq!(state_file(r"C:\ProgramData"), PathBuf::from(r"C:\ProgramData\MyBrainFocus\state.json"));
        assert_eq!(system32_exe(r"C:\Windows", "sc.exe"), r"C:\Windows\System32\sc.exe");
    }

    #[test]
    fn sc_create_for_both_roles() {
        let exe = r"C:\Program Files\MyBrainFocus\focus-helper.exe";
        assert_eq!(
            sc_create_args(Role::Main, exe),
            [
                "create", "MyBrainFocus", "binPath=",
                r#""C:\Program Files\MyBrainFocus\focus-helper.exe" service"#,
                "start=", "auto", "obj=", "LocalSystem", "DisplayName=", "MyBrain Focus Room Helper"
            ]
        );
        let wd = sc_create_args(Role::Watchdog, exe);
        assert_eq!(wd[1], "MyBrainFocusWatchdog");
        assert_eq!(wd[3], r#""C:\Program Files\MyBrainFocus\focus-helper.exe" watchdog"#);
        assert_eq!(sc_config_args(Role::Main, exe)[0], "config");
        assert_eq!(sc_config_args(Role::Main, exe)[1..], sc_create_args(Role::Main, exe)[1..]);
    }

    #[test]
    fn sc_failure_sdset_delete() {
        assert_eq!(
            sc_failure_args(Role::Main),
            ["failure", "MyBrainFocus", "reset=", "60", "actions=", "restart/1000/restart/1000/restart/1000"]
        );
        assert_eq!(
            sc_sdset_args(Role::Watchdog, SERVICE_SDDL),
            ["sdset", "MyBrainFocusWatchdog", "D:(A;;GA;;;SY)(A;;CCLCSWLOCRRC;;;BA)"]
        );
        assert_eq!(sc_delete_args(Role::Watchdog), ["delete", "MyBrainFocusWatchdog"]);
    }

    #[test]
    fn sddls_and_icacls() {
        assert_eq!(PIPE_SDDL, "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)");
        assert_eq!(SERVICE_SDDL_ADMIN_MANAGE, "D:(A;;GA;;;SY)(A;;GA;;;BA)");
        assert_eq!(PIPE_NAME, r"\\.\pipe\mybrain-focus");
        assert_eq!(
            icacls_lockdown_args(r"C:\ProgramData\MyBrainFocus"),
            [r"C:\ProgramData\MyBrainFocus", "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)RX"]
        );
    }

    #[test]
    fn icacls_admin_write() {
        assert_eq!(
            icacls_admin_write_args(r"C:\x"),
            [r"C:\x", "/grant:r", "*S-1-5-32-544:(OI)(CI)F"]
        );
    }

    #[test]
    fn roles() {
        assert_eq!(Role::Main.other(), Role::Watchdog);
        assert_eq!(Role::Watchdog.arg(), "watchdog");
    }
}
