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

/// Pipe DACL: SYSTEM and Administrators full control. Interactive users (IU: anyone logged on at
/// the console or over RDP, not services or network logons) get explicit rights
/// 0x12019b = SYNCHRONIZE | READ_CONTROL | FILE_READ_DATA | FILE_READ_EA | FILE_READ_ATTRIBUTES |
/// FILE_WRITE_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES, i.e. read+write WITHOUT
/// FILE_APPEND_DATA (0x4), which on a pipe means FILE_CREATE_PIPE_INSTANCE. Without that bit an
/// ordinary user can talk to the pipe but cannot create instances of it (no hijacking, no
/// exhausting the instance limit). The service itself creates instances as SYSTEM (GA).
pub const PIPE_SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;IU)";

/// State directory DACL, protected (`P`, no inheritance from ProgramData): SYSTEM full control,
/// Administrators read/execute only, inherited by children. Used at atomic creation so there is
/// no window in which another user could own or write the directory.
pub const STATE_DIR_SDDL: &str = "D:P(A;OICI;GA;;;SY)(A;OICI;GRGX;;;BA)";

pub const SYSTEM_SID: &str = "S-1-5-18";
pub const ADMINS_SID: &str = "S-1-5-32-544";

/// Exit codes the NSIS hook relies on.
pub const EXIT_LOCK_PENDING: u8 = 1;
pub const EXIT_FAILURE: u8 = 3;

/// Service log cap; rotated once to `service.log.old`.
pub const LOG_MAX_BYTES: u64 = 1024 * 1024;
pub const LOG_FILE: &str = "service.log";
/// Install/uninstall log in the temp dir (the state dir may be read-only to the installer's
/// user); same cap as the service log.
pub const INSTALL_LOG_FILE: &str = "mybrain-focus-install.log";

/// `YYYY-MM-DD HH:MM:SS UTC` for a Unix time in milliseconds (civil-from-days, no crates).
pub fn format_utc(unix_ms: i64) -> String {
    let secs = unix_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", sod / 3600, sod % 3600 / 60, sod % 60)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CmdError {
    /// Refused because a locked/frozen window is pending (exit code 1).
    LockPending(String),
    /// Anything else (exit code 3).
    Failed(String),
}

impl CmdError {
    pub fn exit_code(&self) -> u8 {
        match self {
            CmdError::LockPending(_) => EXIT_LOCK_PENDING,
            CmdError::Failed(_) => EXIT_FAILURE,
        }
    }
    pub fn message(&self) -> &str {
        match self {
            CmdError::LockPending(m) | CmdError::Failed(m) => m,
        }
    }
}

/// What to do with the state directory at `%ProgramData%\MyBrainFocus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateDirAction {
    /// Does not exist: create it atomically with `STATE_DIR_SDDL`.
    Create,
    /// Exists, owned by SYSTEM/Administrators: re-assert owner and ACLs, reset children.
    Adopt,
    /// Exists with an untrusted owner (or is not a directory): rename aside, create fresh.
    QuarantineAndRecreate,
    /// Junction or symlink: fail closed.
    RefuseReparsePoint,
}

pub fn state_dir_action(exists: bool, is_reparse: bool, owner_trusted: bool) -> StateDirAction {
    if !exists {
        StateDirAction::Create
    } else if is_reparse {
        StateDirAction::RefuseReparsePoint
    } else if owner_trusted {
        StateDirAction::Adopt
    } else {
        StateDirAction::QuarantineAndRecreate
    }
}

/// What `install`/`uninstall` (run as Administrator) do with the state directory. The SYSTEM
/// service owns and re-asserts its ACL at every start; an Administrator holds only read/execute
/// on an existing one (no WRITE_DAC), so install must never try to change an existing directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallStateDirAction {
    /// Does not exist: create it atomically with `STATE_DIR_SDDL`.
    Create,
    /// Exists: touch nothing (ACL, owner, contents); the service fixes it at next start.
    LeaveAlone,
    RefuseReparsePoint,
}

pub fn install_state_dir_action(exists: bool, is_reparse: bool) -> InstallStateDirAction {
    if !exists {
        InstallStateDirAction::Create
    } else if is_reparse {
        InstallStateDirAction::RefuseReparsePoint
    } else {
        InstallStateDirAction::LeaveAlone
    }
}

/// Files the helper itself keeps in the state directory.
pub const EXPECTED_STATE_FILES: [&str; 5] =
    ["state.json", "state.json.bak", "state.json.tmp", "service.log", "service.log.old"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildAction {
    /// Reserved: leave untouched.
    Keep,
    /// Expected regular file: `icacls <file> /reset` (per file, no recursion).
    ResetAcl,
    /// Junction or symlink: delete the link itself, never its target.
    RemoveLink,
    /// Unexpected regular file: delete.
    RemoveFile,
    /// Unexpected subdirectory: remove non-recursively, else quarantine the whole state dir.
    QuarantineDir,
}

/// Decide what to do with one immediate child of an adopted state directory. Reparse points are
/// checked first so a junction named like an expected file is still removed, never followed.
pub fn classify_child(name: &str, is_dir: bool, is_reparse: bool) -> ChildAction {
    if is_reparse {
        ChildAction::RemoveLink
    } else if is_dir {
        ChildAction::QuarantineDir
    } else if EXPECTED_STATE_FILES.iter().any(|f| f.eq_ignore_ascii_case(name)) {
        ChildAction::ResetAcl
    } else {
        ChildAction::RemoveFile
    }
}

/// Temporary name the new exe is copied to before being renamed over the installed one.
pub fn temp_exe_path(exe: &str) -> String {
    format!("{exe}.new")
}

/// `sc config <svc> start= auto` for every service, used unconditionally by recovery paths.
pub fn restore_start_auto_args() -> Vec<Vec<String>> {
    [Role::Main, Role::Watchdog].iter().map(|r| sc_config_start_args(*r, "auto")).collect()
}

pub fn icacls_reset_file_args(file: &str) -> Vec<String> {
    vec![file.into(), "/reset".into()]
}

pub fn is_trusted_owner(sid: &str) -> bool {
    sid == SYSTEM_SID || sid == ADMINS_SID
}

pub fn quarantine_dir_name(unix_ms: i64) -> String {
    format!("{DIR_NAME}.untrusted-{unix_ms}")
}

/// Delay before retrying a failed pipe-instance creation: 250 ms doubling, capped at 5 s.
pub fn pipe_retry_delay_ms(attempt: u32) -> u64 {
    250u64.saturating_mul(1u64 << attempt.min(10)).min(5_000)
}

/// One log line: timestamp, message with line breaks flattened.
pub fn log_line(unix_ms: i64, msg: &str) -> String {
    format!("{unix_ms} {}\n", msg.replace(['\r', '\n'], " "))
}

/// Join a directory and a file name with a backslash.
pub fn dir_file(dir: &str, name: &str) -> String {
    format!("{}\\{}", dir.trim_end_matches('\\'), name)
}

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

/// Also restart when the service exits with a non-zero code (not just on a crash).
pub fn sc_failureflag_args(role: Role) -> Vec<String> {
    vec!["failureflag".into(), role.service_name().into(), "1".into()]
}

/// `start` is `auto` or `disabled`. Disabling both services first stops the peer watchdog from
/// reviving one while the other is being stopped for an upgrade or uninstall.
pub fn sc_config_start_args(role: Role, start: &str) -> Vec<String> {
    vec!["config".into(), role.service_name().into(), "start=".into(), start.into()]
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
pub fn icacls_setowner_args(target: &str, sid: &str, recursive: bool) -> Vec<String> {
    let mut v = vec![target.to_string(), "/setowner".into(), format!("*{sid}")];
    if recursive {
        v.push("/T".into());
        v.push("/C".into());
    }
    v
}

pub fn icacls_admin_write_args(dir: &str) -> Vec<String> {
    vec![dir.into(), "/grant:r".into(), "*S-1-5-32-544:(OI)(CI)F".into()]
}

// ---- lock predicates ----

/// A locked or frozen window is in force right now (informational; Stop uses `lock_pending`).
pub fn lock_active(windows: &[Window], now_ms: i64) -> bool {
    windows.iter().any(|w| w.lock != Lock::None && w.starts <= now_ms && now_ms < w.ends)
}

/// Any locked or frozen window that has not ended yet (active or still to come).
pub fn lock_pending(windows: &[Window], now_ms: i64) -> bool {
    windows.iter().any(|w| w.lock != Lock::None && w.ends > now_ms)
}

/// Gates the service Stop control: while any locked/frozen window is pending (active or still to
/// come, `ends > now`) the helper ignores Stop; Shutdown is always honored. This matches the
/// install/uninstall refusal, so a lock scheduled ahead cannot be dodged by stopping the services.
pub fn stop_allowed(windows: &[Window], now_ms: i64) -> bool {
    !lock_pending(windows, now_ms)
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
            "a locked or frozen focus window is still active or scheduled (latest ends at {}); \
             it cannot be removed until it ends or the partner unlocks it",
            format_utc(ends)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Mode;

    fn w(lock: Lock, starts: i64, ends: i64) -> Window {
        Window { id: "w".into(), starts, ends, lock, mode: Mode::Block, sites: vec![], apps: vec![], unlock_delay_ms: None }
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
    fn format_utc_known_values() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(format_utc(1_709_208_000_000), "2024-02-29 12:00:00 UTC"); // leap day
        assert_eq!(format_utc(951_782_400_000), "2000-02-29 00:00:00 UTC"); // 400-year leap
        assert_eq!(format_utc(1_700_000_000_000), "2023-11-14 22:13:20 UTC");
        assert_eq!(format_utc(1_700_000_000_999), "2023-11-14 22:13:20 UTC");
        assert_eq!(format_utc(-1000), "1969-12-31 23:59:59 UTC");
    }

    #[test]
    fn refusal_message_shows_a_readable_end_time() {
        let msg = uninstall_decision(&[w(Lock::Locked, 0, 1_700_000_000_000)], 50).unwrap_err();
        assert!(msg.contains("2023-11-14 22:13:20 UTC"), "{msg}");
        assert!(!msg.contains("1700000000000"), "{msg}");
    }

    #[test]
    fn stop_allowed_follows_pending_locks() {
        assert!(stop_allowed(&[], 50));
        assert!(!stop_allowed(&[w(Lock::Locked, 0, 100)], 50));
        assert!(!stop_allowed(&[w(Lock::Frozen, 0, 100)], 99));
        assert!(stop_allowed(&[w(Lock::Locked, 0, 100)], 100));
        assert!(!stop_allowed(&[w(Lock::Locked, 200, 300)], 50), "pending future lock also blocks Stop");
        assert!(stop_allowed(&[w(Lock::Locked, 200, 300)], 300));
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
        assert_eq!(PIPE_SDDL, "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;IU)");
        assert_eq!(0x12019b & 0x4, 0, "no FILE_APPEND_DATA / CREATE_PIPE_INSTANCE for users");
        assert_eq!(STATE_DIR_SDDL, "D:P(A;OICI;GA;;;SY)(A;OICI;GRGX;;;BA)");
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
    fn failureflag_and_start_type() {
        assert_eq!(sc_failureflag_args(Role::Main), ["failureflag", "MyBrainFocus", "1"]);
        assert_eq!(sc_config_start_args(Role::Watchdog, "disabled"), ["config", "MyBrainFocusWatchdog", "start=", "disabled"]);
    }

    #[test]
    fn owner_and_reset_args() {
        assert_eq!(icacls_setowner_args(r"C:\d", SYSTEM_SID, true), [r"C:\d", "/setowner", "*S-1-5-18", "/T", "/C"]);
        assert_eq!(icacls_setowner_args(r"C:\d", ADMINS_SID, false), [r"C:\d", "/setowner", "*S-1-5-32-544"]);
        assert_eq!(icacls_reset_file_args(r"C:\d\state.json"), [r"C:\d\state.json", "/reset"]);
    }

    #[test]
    fn state_dir_decisions() {
        use StateDirAction::*;
        assert_eq!(state_dir_action(false, false, false), Create);
        assert_eq!(state_dir_action(true, true, true), RefuseReparsePoint);
        assert_eq!(state_dir_action(true, true, false), RefuseReparsePoint);
        assert_eq!(state_dir_action(true, false, true), Adopt);
        assert_eq!(state_dir_action(true, false, false), QuarantineAndRecreate);
        assert!(is_trusted_owner("S-1-5-18") && is_trusted_owner("S-1-5-32-544"));
        assert!(!is_trusted_owner("S-1-5-21-1-2-3-1001"));
        assert_eq!(quarantine_dir_name(42), "MyBrainFocus.untrusted-42");
    }

    #[test]
    fn child_classification() {
        use ChildAction::*;
        assert_eq!(classify_child("state.json", false, true), RemoveLink, "junction named like a file");
        assert_eq!(classify_child("state.json", true, true), RemoveLink);
        assert_eq!(classify_child("evil.txt", false, false), RemoveFile);
        assert_eq!(classify_child("state.json", false, false), ResetAcl);
        assert_eq!(classify_child("STATE.JSON.BAK", false, false), ResetAcl);
        assert_eq!(classify_child("service.log.old", false, false), ResetAcl);
        assert_eq!(classify_child("sub", true, false), QuarantineDir);
        assert_eq!(classify_child("state.json", true, false), QuarantineDir);
    }

    #[test]
    fn install_leaves_existing_state_dir_alone() {
        use InstallStateDirAction::*;
        assert_eq!(install_state_dir_action(false, false), Create);
        assert_eq!(install_state_dir_action(true, false), LeaveAlone);
        assert_eq!(install_state_dir_action(true, true), RefuseReparsePoint);
    }

    #[test]
    fn recovery_arg_vectors() {
        assert_eq!(
            restore_start_auto_args(),
            vec![
                vec!["config", "MyBrainFocus", "start=", "auto"],
                vec!["config", "MyBrainFocusWatchdog", "start=", "auto"],
            ]
        );
        assert_eq!(
            temp_exe_path(r"C:\Program Files\MyBrainFocus\focus-helper.exe"),
            r"C:\Program Files\MyBrainFocus\focus-helper.exe.new"
        );
    }

    #[test]
    fn retry_backoff_schedule() {
        let d: Vec<u64> = (0..8).map(pipe_retry_delay_ms).collect();
        assert_eq!(d, [250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
        assert_eq!(pipe_retry_delay_ms(u32::MAX), 5000);
    }

    #[test]
    fn cmd_error_codes_and_log_line() {
        assert_eq!(CmdError::LockPending("x".into()).exit_code(), 1);
        assert_eq!(CmdError::Failed("x".into()).exit_code(), 3);
        assert_eq!(log_line(7, "a\nb\r"), "7 a b \n");
        assert_eq!(dir_file(r"C:\Windows\System32", "sc.exe"), r"C:\Windows\System32\sc.exe");
        assert_eq!(dir_file(r"C:\x\", "y"), r"C:\x\y");
    }

    #[test]
    fn roles() {
        assert_eq!(Role::Main.other(), Role::Watchdog);
        assert_eq!(Role::Watchdog.arg(), "watchdog");
    }
}
