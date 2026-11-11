//! Known-folder paths (not caller environment variables), secure state-dir handling and small
//! process helpers shared by the service and installer. Windows only.

use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{LocalFree, S_OK};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{CreateDirectoryW, GetFileAttributesW};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::UI::Shell::{
    FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX64, SHGetKnownFolderPath,
};

use crate::service_logic::{self, StateDirAction};

const INVALID_FILE_ATTRIBUTES: u32 = 0xFFFF_FFFF;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_os(p: &Path) -> Vec<u16> {
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn from_wide_ptr(p: *const u16) -> String {
    // SAFETY: callers pass NUL-terminated strings returned by the OS.
    unsafe {
        let mut len = 0;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }
}

fn known_folder(id: &GUID) -> Option<String> {
    let mut out: *mut u16 = std::ptr::null_mut();
    // SAFETY: `out` receives a CoTaskMem-allocated string, freed below.
    let hr = unsafe { SHGetKnownFolderPath(id, 0, 0, &mut out) };
    if hr != S_OK || out.is_null() {
        return None;
    }
    let s = from_wide_ptr(out);
    // SAFETY: allocated by SHGetKnownFolderPath.
    unsafe { CoTaskMemFree(out as *const c_void) };
    Some(s)
}

/// The native 64-bit Program Files, whatever the caller's bitness (falls back to the plain
/// known folder on 32-bit Windows).
pub fn program_files() -> String {
    known_folder(&FOLDERID_ProgramFilesX64)
        .or_else(|| known_folder(&FOLDERID_ProgramFiles))
        .unwrap_or_else(|| r"C:\Program Files".to_string())
}

pub fn program_data() -> String {
    known_folder(&FOLDERID_ProgramData).unwrap_or_else(|| r"C:\ProgramData".to_string())
}

/// The single install directory, used by both install and uninstall.
pub fn install_dir() -> String {
    service_logic::install_dir(&program_files())
}

pub fn install_exe() -> String {
    service_logic::install_exe(&program_files())
}

pub fn system_dir() -> String {
    let mut buf = [0u16; 260];
    // SAFETY: buffer and its length match.
    let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return r"C:\Windows\System32".to_string();
    }
    String::from_utf16_lossy(&buf[..n])
}

/// Absolute `<System directory>\<exe>`.
pub fn system32_exe(exe: &str) -> String {
    service_logic::dir_file(&system_dir(), exe)
}

pub fn state_dir() -> PathBuf {
    PathBuf::from(service_logic::state_dir(&program_data()))
}

pub fn state_file() -> PathBuf {
    service_logic::state_file(&program_data())
}

pub fn usage_file() -> PathBuf {
    service_logic::usage_file(&program_data())
}

/// Run an absolute-path tool, returning an error carrying its output on failure.
pub fn run_exe(exe: PathBuf, args: &[String]) -> io::Result<()> {
    let out = Command::new(&exe).args(args).output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} {:?} failed ({}): {} {}",
            exe.display(),
            args,
            out.status,
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

pub fn sc(args: &[String]) -> io::Result<()> {
    run_exe(PathBuf::from(system32_exe("sc.exe")), args)
}

pub fn icacls(args: &[String]) -> io::Result<()> {
    run_exe(PathBuf::from(system32_exe("icacls.exe")), args)
}

/// Make `dir` writable by SYSTEM only (Administrators read/execute, no Users access).
pub fn lock_down_dir(dir: &str) -> io::Result<()> {
    icacls(&service_logic::icacls_lockdown_args(dir))
}

/// Run `f` with SECURITY_ATTRIBUTES built from `sddl`; the descriptor is freed afterwards.
pub fn with_security_attributes<R>(sddl: &str, f: impl FnOnce(*mut SECURITY_ATTRIBUTES) -> R) -> io::Result<R> {
    let sddl = wide(sddl);
    let mut descriptor: *mut c_void = std::ptr::null_mut();
    // SAFETY: `sddl` is NUL-terminated; `descriptor` receives a LocalAlloc'd buffer freed below.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let r = f(&mut attrs);
    // SAFETY: from the conversion call above; the kernel copied what it needed.
    unsafe { LocalFree(descriptor) };
    Ok(r)
}

fn file_attributes(path: &Path) -> Option<u32> {
    let w = wide_os(path);
    // SAFETY: NUL-terminated path.
    let a = unsafe { GetFileAttributesW(w.as_ptr()) };
    (a != INVALID_FILE_ATTRIBUTES).then_some(a)
}

/// Owner of `path` as a SID string, or `None` when it cannot be determined (treated as untrusted).
fn owner_sid(path: &Path) -> Option<String> {
    let w = wide_os(path);
    let mut owner: *mut c_void = std::ptr::null_mut();
    let mut sd: *mut c_void = std::ptr::null_mut();
    // SAFETY: out-pointers are valid; `sd` is freed below and `owner` points into it.
    let rc = unsafe {
        GetNamedSecurityInfoW(
            w.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if rc != 0 || owner.is_null() {
        return None;
    }
    let mut s: *mut u16 = std::ptr::null_mut();
    // SAFETY: `owner` is a valid SID inside `sd`.
    let ok = unsafe { ConvertSidToStringSidW(owner, &mut s) };
    let out = if ok != 0 && !s.is_null() {
        let v = from_wide_ptr(s);
        // SAFETY: allocated by ConvertSidToStringSidW.
        unsafe { LocalFree(s as *mut c_void) };
        Some(v)
    } else {
        None
    };
    // SAFETY: allocated by GetNamedSecurityInfoW.
    unsafe { LocalFree(sd) };
    out
}

fn create_dir_secure(path: &Path) -> io::Result<()> {
    let w = wide_os(path);
    let ok = with_security_attributes(service_logic::STATE_DIR_SDDL, |sa| {
        // SAFETY: NUL-terminated path and valid attributes. Fails if the directory exists, so an
        // attacker who raced us to create it cannot be adopted by mistake.
        unsafe { CreateDirectoryW(w.as_ptr(), sa) }
    })?;
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn quarantine_and_recreate(dir: &Path) -> io::Result<Option<String>> {
    let parent = dir.parent().ok_or_else(|| io::Error::other("state dir has no parent"))?;
    let aside = parent.join(service_logic::quarantine_dir_name(wall_ms()));
    std::fs::rename(dir, &aside)?;
    create_dir_secure(dir)?;
    Ok(Some(format!(
        "state directory was not trustworthy; moved to {} and recreated empty",
        aside.display()
    )))
}

/// Clean the immediate children of a trusted-owner state directory WITHOUT recursing or following
/// reparse points (a recursive icacls as SYSTEM would follow a planted junction into e.g.
/// C:\Windows). Returns the files to ACL-reset after the directory lockdown, or `Ok(None)` when a
/// child could not be handled and the whole directory must be quarantined instead.
fn clean_children(dir: &Path) -> io::Result<Option<Vec<PathBuf>>> {
    let mut reset = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        // GetFileAttributesW describes a reparse point itself, it does not follow it.
        let Some(attrs) = file_attributes(&path) else { return Ok(None) };
        let is_reparse = attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
        let removed = match service_logic::classify_child(&name, is_dir, is_reparse) {
            service_logic::ChildAction::Keep => Ok(()),
            service_logic::ChildAction::ResetAcl => {
                reset.push(path.clone());
                Ok(())
            }
            // remove_dir / remove_file delete the link itself, never its target.
            service_logic::ChildAction::RemoveLink => {
                crate::win::log::log(&format!("removing reparse point {}", path.display()));
                if is_dir { std::fs::remove_dir(&path) } else { std::fs::remove_file(&path) }
            }
            service_logic::ChildAction::RemoveFile => {
                crate::win::log::log(&format!("removing unexpected file {}", path.display()));
                std::fs::remove_file(&path)
            }
            // Non-recursive: fails when non-empty.
            service_logic::ChildAction::QuarantineDir => std::fs::remove_dir(&path),
        };
        if removed.is_err() {
            return Ok(None);
        }
    }
    Ok(Some(reset))
}

/// Create or re-assert the state directory so only SYSTEM can write it. Called by the SYSTEM
/// SERVICE at every start; `install`/`uninstall` use `ensure_state_dir_for_install` instead.
/// A non-admin can pre-create `%ProgramData%\MyBrainFocus` and would own it (an owner keeps
/// WRITE_DAC), so an existing directory is trusted only if SYSTEM/Administrators own it and it is
/// not a reparse point; otherwise it is renamed aside and recreated. Returns a warning when
/// something was quarantined.
pub fn ensure_state_dir() -> io::Result<Option<String>> {
    let dir = state_dir();
    let attrs = file_attributes(&dir);
    let exists = attrs.is_some();
    let a = attrs.unwrap_or(0);
    let is_reparse = a & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    let is_dir = a & FILE_ATTRIBUTE_DIRECTORY != 0;
    let owner_trusted = exists && is_dir && owner_sid(&dir).is_some_and(|s| service_logic::is_trusted_owner(&s));
    let dir_s = dir.to_string_lossy().to_string();
    match service_logic::state_dir_action(exists, is_reparse, owner_trusted) {
        StateDirAction::Create => {
            create_dir_secure(&dir)?;
            Ok(None)
        }
        StateDirAction::RefuseReparsePoint => Err(io::Error::other(format!(
            "{dir_s} is a reparse point (junction or symlink); refusing to use it"
        ))),
        StateDirAction::Adopt => match clean_children(&dir)? {
            None => quarantine_and_recreate(&dir),
            Some(reset) => {
                // Non-recursive, protected lockdown of the directory itself; inheritable ACEs
                // reach the (already vetted) children, then each file is reset individually.
                lock_down_dir(&dir_s)?;
                for f in reset {
                    let _ = icacls(&service_logic::icacls_reset_file_args(&f.to_string_lossy()));
                }
                Ok(None)
            }
        },
        StateDirAction::QuarantineAndRecreate => quarantine_and_recreate(&dir),
    }
}

/// For `install`/`uninstall` (run as an Administrator): create the directory atomically if it is
/// missing; if it exists, change nothing (an Administrator has only read/execute on a
/// SYSTEM-owned directory and could not re-ACL it anyway) except refusing a reparse point. The
/// service re-asserts ownership and ACLs at its next start.
pub fn ensure_state_dir_for_install() -> io::Result<()> {
    use service_logic::InstallStateDirAction as A;
    let dir = state_dir();
    let attrs = file_attributes(&dir);
    let is_reparse = attrs.is_some_and(|a| a & FILE_ATTRIBUTE_REPARSE_POINT != 0);
    match service_logic::install_state_dir_action(attrs.is_some(), is_reparse) {
        A::Create => create_dir_secure(&dir),
        A::LeaveAlone => Ok(()),
        A::RefuseReparsePoint => Err(io::Error::other(format!(
            "{} is a reparse point (junction or symlink); refusing to use it",
            dir.display()
        ))),
    }
}

pub fn state_dir_is_reparse() -> bool {
    file_attributes(&state_dir()).is_some_and(|a| a & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

/// Wall-clock milliseconds since the Unix epoch.
pub fn wall_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
