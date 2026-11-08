//! Pure decision of what is blocked at a point in time. Mirrors src/modules/focus/decide.js.
use crate::model::{Allow, Decision, Lock, LockInfo, Mode, Window};
use std::collections::BTreeSet;

pub const CRITICAL_APPS: &[&str] = &[
    "system", "system idle process", "registry", "smss.exe", "csrss.exe", "wininit.exe",
    "winlogon.exe", "services.exe", "lsass.exe", "svchost.exe", "dwm.exe", "explorer.exe",
    "fontdrvhost.exe", "sihost.exe", "taskhostw.exe", "ctfmon.exe", "conhost.exe",
    "runtimebroker.exe", "searchhost.exe", "startmenuexperiencehost.exe",
    "shellexperiencehost.exe", "audiodg.exe", "spoolsv.exe", "msedgewebview2.exe",
    "mybrain.exe", "focus-helper.exe",
];

// Sorted by Rust `str` ordering (UTF-8 bytes); JS sorts by UTF-16 code units.
// These agree for ASCII, which is all domains and process names normally contain.
fn uniq_sorted<'a>(xs: impl Iterator<Item = &'a String>) -> Vec<String> {
    xs.cloned().collect::<BTreeSet<_>>().into_iter().collect()
}

pub fn decide(windows: &[Window], now_ms: i64) -> Decision {
    let active: Vec<&Window> = windows
        .iter()
        .filter(|w| w.starts <= now_ms && now_ms < w.ends)
        .collect();
    let blocks: Vec<&&Window> = active.iter().filter(|w| w.mode == Mode::Block).collect();
    let allows: Vec<&&Window> = active.iter().filter(|w| w.mode == Mode::Allow).collect();
    let mut locks: Vec<LockInfo> = active
        .iter()
        .filter(|w| w.lock != Lock::None)
        .map(|w| LockInfo { id: w.id.clone(), lock: w.lock, ends: w.ends })
        .collect();
    locks.sort_by(|a, b| a.id.cmp(&b.id));
    Decision {
        block_sites: uniq_sorted(blocks.iter().flat_map(|w| w.sites.iter())),
        block_apps: uniq_sorted(blocks.iter().flat_map(|w| w.apps.iter())),
        allow: if allows.is_empty() {
            None
        } else {
            Some(Allow {
                sites: uniq_sorted(allows.iter().flat_map(|w| w.sites.iter())),
                apps: uniq_sorted(allows.iter().flat_map(|w| w.apps.iter())),
            })
        },
        frozen: active.iter().any(|w| w.lock == Lock::Frozen),
        locks,
    }
}

pub fn host_matches(host: &str, domain: &str) -> bool {
    host == domain
        || (host.len() > domain.len()
            && host.ends_with(domain)
            && host.as_bytes()[host.len() - domain.len() - 1] == b'.')
}

pub fn normalize_app(name: &str) -> String {
    let base = name
        .trim()
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("")
        .to_lowercase();
    if base.ends_with(".exe") {
        base
    } else {
        format!("{base}.exe")
    }
}

pub fn is_blocked_site(d: &Decision, host: &str) -> bool {
    let lower = host.trim().to_lowercase();
    let h = lower.trim_end_matches('.');
    if h.is_empty() {
        return false;
    }
    if d.block_sites.iter().any(|s| host_matches(h, s)) {
        return true;
    }
    match &d.allow {
        Some(a) => !a.sites.iter().any(|s| host_matches(h, s)),
        None => false,
    }
}

pub fn is_blocked_app(d: &Decision, name: &str) -> bool {
    if name.trim().is_empty() {
        return false;
    }
    let n = normalize_app(name);
    if CRITICAL_APPS.iter().any(|c| normalize_app(c) == n) {
        return false;
    }
    if d.block_apps.iter().any(|a| normalize_app(a) == n) {
        return true;
    }
    if d.allow.is_some() || d.frozen {
        let listed = d
            .allow
            .as_ref()
            .map_or(false, |a| a.apps.iter().any(|x| normalize_app(x) == n));
        return !listed;
    }
    false
}
