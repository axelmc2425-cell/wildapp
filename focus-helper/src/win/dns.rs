//! Hosts-file ACL lock, DNS flush and browser DoH policy (Windows only).

use std::io;
use std::path::PathBuf;
use std::process::Command;
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_ALL_ACCESS, KEY_READ};
use winreg::RegKey;


pub fn hosts_path() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("drivers").join("etc").join("hosts")
}

/// Absolute `%SystemRoot%\System32\<exe>`, never a PATH lookup (the helper runs as SYSTEM).
pub fn sys32(exe: &str) -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    PathBuf::from(crate::service_logic::system32_exe(&root, exe))
}

fn run(cmd: &mut Command) -> io::Result<()> {
    let out = cmd.output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Other,
            format!(
                "{:?} failed ({}): stdout: {} stderr: {}",
                cmd.get_program(),
                out.status,
                String::from_utf8_lossy(&out.stdout).trim(),
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        ))
    }
}

/// Allow-only lock: SYSTEM (S-1-5-18) is the only writer, Administrators
/// (S-1-5-32-544) read/execute, Users (S-1-5-32-545) read. No deny entries, so the
/// SYSTEM-run helper can never be locked out by a group in its token.
///
/// `fs::rename` in `hosts_io::apply` replaces the file, and the new file inherits
/// the directory ACL, losing this lock. The lock must therefore follow EVERY apply;
/// use `enforce_hosts`. It is idempotent (`/grant:r` replaces, `/inheritance:r`
/// repeats harmlessly), so calling it after an unchanged apply is cheap.
pub fn lock_hosts() -> io::Result<()> {
    run(Command::new(sys32("icacls.exe"))
        .arg(hosts_path())
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg("*S-1-5-18:F")
        .arg("*S-1-5-32-544:RX")
        .arg("*S-1-5-32-545:R"))
}

/// Restore the inherited default ACL (undoes `lock_hosts`).
pub fn unlock_hosts() -> io::Result<()> {
    run(Command::new(sys32("icacls.exe")).arg(hosts_path()).arg("/reset"))
}

/// Write the managed block, then fix the ACL, then flush DNS.
///
/// Order matters: `apply` replaces the file (rename), which resets its ACL, so
/// `lock_hosts` runs after every apply, even when apply changed nothing, to restore
/// a lost lock. A non-empty `sites` is treated as an active block (the lock is
/// kept even if every entry were filtered as unsafe); empty `sites` unlocks.
/// DNS is flushed only when the file changed. Returns whether the file changed.
///
/// Task 14's checklist must test lock -> apply -> unlock as SYSTEM.
pub fn enforce_hosts(sites: &[String]) -> io::Result<bool> {
    let changed = crate::hosts_io::apply(&hosts_path(), sites)?;
    if sites.is_empty() {
        unlock_hosts()?;
    } else {
        lock_hosts()?;
    }
    if changed {
        flush_dns()?;
    }
    Ok(changed)
}

pub fn flush_dns() -> io::Result<()> {
    run(Command::new(sys32("ipconfig.exe")).arg("/flushdns"))
}

#[derive(Clone, Copy)]
enum Val {
    Str(&'static str),
    Dword(u32),
}

/// (key path, value name, value we want)
const POLICIES: &[(&str, &str, Val)] = &[
    (r"SOFTWARE\Policies\Google\Chrome", "DnsOverHttpsMode", Val::Str("off")),
    (r"SOFTWARE\Policies\Microsoft\Edge", "DnsOverHttpsMode", Val::Str("off")),
    (r"SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS", "Enabled", Val::Dword(0)),
    (r"SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS", "Locked", Val::Dword(1)),
];

const FIREFOX_KEY: &str = r"SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS";
/// Our own bookkeeping key: lists the "key|value" entries this helper created.
const OWNED_KEY: &str = r"SOFTWARE\MyBrainFocus";
const OWNED_VALUE: &str = "DohPolicyOwned";

fn id(path: &str, name: &str) -> String {
    format!("{path}|{name}")
}

fn read_owned(hklm: &RegKey) -> Vec<String> {
    hklm.open_subkey_with_flags(OWNED_KEY, KEY_READ)
        .and_then(|k| k.get_value::<Vec<String>, _>(OWNED_VALUE))
        .unwrap_or_default()
}

fn write_owned(hklm: &RegKey, owned: &[String]) -> io::Result<()> {
    let (k, _) = hklm.create_subkey(OWNED_KEY)?;
    if owned.is_empty() {
        match k.delete_value(OWNED_VALUE) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        Ok(())
    } else {
        k.set_value(OWNED_VALUE, &owned.to_vec())
    }
}

fn matches_ours(key: &RegKey, name: &str, want: Val) -> bool {
    match want {
        Val::Str(s) => key.get_value::<String, _>(name).map(|v| v == s).unwrap_or(false),
        Val::Dword(d) => key.get_value::<u32, _>(name).map(|v| v == d).unwrap_or(false),
    }
}

fn exists(key: &RegKey, name: &str) -> bool {
    key.get_raw_value(name).is_ok()
}

fn describe(key: &RegKey, name: &str) -> String {
    if let Ok(v) = key.get_value::<String, _>(name) {
        format!("'{v}'")
    } else if let Ok(v) = key.get_value::<u32, _>(name) {
        v.to_string()
    } else {
        "of another type".to_string()
    }
}

/// Disable browser encrypted DNS via HKLM policies.
///
/// Returns the human-readable entries that could NOT be enforced because an
/// existing value with different content was left in place; an empty vec means
/// fully enforced. Admin settings are never overwritten or later removed.
///
/// Ownership: a value is written only when it does not exist. The intent is
/// recorded in `HKLM\SOFTWARE\MyBrainFocus\DohPolicyOwned` BEFORE the value is
/// written, so a crash can never leave a value we wrote unrecorded (clear tolerates
/// a recorded value that is absent). An existing, unrecorded value equal to ours is
/// not adopted (it may be an admin's identical setting) and is never removed.
pub fn set_doh_off() -> io::Result<Vec<String>> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut owned = read_owned(&hklm);
    let mut unenforced = Vec::new();
    for (path, name, want) in POLICIES {
        let (key, _) = hklm.create_subkey(path)?;
        if exists(&key, name) {
            if !matches_ours(&key, name, *want) {
                unenforced.push(format!(
                    "HKLM\\{path}\\{name} (existing value {} left in place)",
                    describe(&key, name)
                ));
            }
            continue;
        }
        let entry = id(path, name);
        if !owned.contains(&entry) {
            owned.push(entry);
            write_owned(&hklm, &owned)?; // record first, then write
        }
        match want {
            Val::Str(s) => key.set_value(name, s)?,
            Val::Dword(d) => key.set_value(name, d)?,
        }
    }
    Ok(unenforced)
}

/// Remove only the values `set_doh_off` created (and still equal to ours).
/// The Firefox key is deleted only if it ends up empty.
pub fn clear_doh_off() -> io::Result<()> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut owned = read_owned(&hklm);
    let mut cleared_firefox = false;
    for (path, name, want) in POLICIES {
        let entry = id(path, name);
        if !owned.contains(&entry) {
            continue;
        }
        if let Ok(key) = hklm.open_subkey_with_flags(path, KEY_ALL_ACCESS) {
            // If someone changed it since, it is no longer ours: leave it.
            if matches_ours(&key, name, *want) {
                match key.delete_value(name) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                    _ => {}
                }
            }
        }
        cleared_firefox |= *path == FIREFOX_KEY;
        owned.retain(|e| e != &entry);
        write_owned(&hklm, &owned)?;
    }
    if !cleared_firefox {
        return Ok(());
    }
    if let Ok(key) = hklm.open_subkey_with_flags(FIREFOX_KEY, KEY_READ) {
        let empty = key.enum_values().next().is_none() && key.enum_keys().next().is_none();
        drop(key);
        if empty {
            let _ = hklm.delete_subkey(FIREFOX_KEY);
        }
    }
    Ok(())
}
