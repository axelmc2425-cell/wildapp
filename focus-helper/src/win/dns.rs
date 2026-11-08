//! Hosts-file ACL lock, DNS flush and browser DoH policy (Windows only).

use std::io;
use std::path::PathBuf;
use std::process::Command;
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_ALL_ACCESS, KEY_READ};
use winreg::RegKey;

/// Well-known SID of the built-in Users group (locale independent).
const USERS_SID: &str = "*S-1-5-32-545";

pub fn hosts_path() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("drivers").join("etc").join("hosts")
}

fn run(cmd: &mut Command) -> io::Result<()> {
    let out = cmd.output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Other,
            format!(
                "{:?} failed ({}): {}",
                cmd.get_program(),
                out.status,
                String::from_utf8_lossy(&out.stdout).trim()
            ),
        ))
    }
}

/// Deny write, delete and delete-child to the Users group on the hosts file.
pub fn lock_hosts() -> io::Result<()> {
    run(Command::new("icacls")
        .arg(hosts_path())
        .arg("/deny")
        .arg(format!("{USERS_SID}:(W,D,DC)")))
}

/// Remove the deny entry added by `lock_hosts`.
pub fn unlock_hosts() -> io::Result<()> {
    run(Command::new("icacls")
        .arg(hosts_path())
        .arg("/remove:d")
        .arg(USERS_SID))
}

pub fn flush_dns() -> io::Result<()> {
    run(Command::new("ipconfig").arg("/flushdns"))
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

/// Disable browser encrypted DNS via HKLM policies.
///
/// Behaviour with pre-existing admin settings: a value is written only when it
/// does not exist yet, and only then is it recorded as ours. A value that already
/// exists (same or different content) is left alone and is never removed later.
pub fn set_doh_off() -> io::Result<()> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut owned = read_owned(&hklm);
    for (path, name, want) in POLICIES {
        let (key, _) = hklm.create_subkey(path)?;
        if exists(&key, name) {
            continue; // ours from an earlier run (already recorded) or the admin's
        }
        match want {
            Val::Str(s) => key.set_value(name, s)?,
            Val::Dword(d) => key.set_value(name, d)?,
        }
        let entry = id(path, name);
        if !owned.contains(&entry) {
            owned.push(entry);
            write_owned(&hklm, &owned)?; // record immediately so a crash cannot orphan it
        }
    }
    Ok(())
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
