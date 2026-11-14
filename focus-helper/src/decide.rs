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
    // Logon/UAC/session, shell hosts, security and servicing: killing any of these can lock the
    // owner out of Windows, so they are never killed even in an allow-list.
    "logonui.exe", "consent.exe", "credentialuibroker.exe", "userinit.exe", "lockapp.exe",
    "dllhost.exe", "wmiprvse.exe", "applicationframehost.exe", "textinputhost.exe",
    "securityhealthservice.exe", "msmpeng.exe", "nissrv.exe", "searchindexer.exe",
    "wudfhost.exe", "tiworker.exe", "trustedinstaller.exe", "sgrmbroker.exe",
    "dashost.exe", "smartscreen.exe", "backgroundtaskhost.exe", "memory compression",
    "secure system", "sppsvc.exe", "searchapp.exe", "shellhost.exe",
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
        block_folders: uniq_sorted(blocks.iter().flat_map(|w| w.app_folders.iter())),
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
        limit_blocks: Vec::new(),
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

/// True when `path` is inside (or is) one of `d.block_folders`. Both sides are ASCII-lowercased,
/// `/` becomes `\`, trailing `\` is stripped; a match is equality or `folder + \` prefix.
pub fn is_blocked_path(d: &Decision, path: &str) -> bool {
    let p = norm_path(path);
    if p.is_empty() {
        return false;
    }
    d.block_folders.iter().any(|f| {
        let f = norm_path(f);
        !f.is_empty()
            && (p == f || (p.len() > f.len() && p.starts_with(&f) && p.as_bytes()[f.len()] == b'\\'))
    })
}

fn norm_path(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace('/', "\\").trim_end_matches('\\').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(id: &str, mode: Mode, folders: &[&str]) -> Window {
        Window {
            id: id.into(),
            starts: 0,
            ends: 100,
            lock: Lock::None,
            mode,
            sites: vec![],
            apps: vec![],
            app_folders: folders.iter().map(|s| s.to_string()).collect(),
            unlock_delay_ms: None,
        }
    }

    #[test]
    fn block_folders_merged_sorted_deduped() {
        let ws = [
            win("a", Mode::Block, &["C:\\Games", "C:\\Apps"]),
            win("b", Mode::Block, &["C:\\Games", "C:\\Zed"]),
        ];
        let d = decide(&ws, 1);
        assert_eq!(d.block_folders, ["C:\\Apps", "C:\\Games", "C:\\Zed"]);
    }

    #[test]
    fn allow_mode_folders_ignored() {
        let d = decide(&[win("a", Mode::Allow, &["C:\\Games"])], 1);
        assert!(d.block_folders.is_empty());
    }

    #[test]
    fn path_match_boundaries() {
        let d = decide(&[win("a", Mode::Block, &["C:\\Games"])], 1);
        assert!(is_blocked_path(&d, "c:/games/x/y.exe"));
        assert!(is_blocked_path(&d, "C:\\Games\\"));
        assert!(is_blocked_path(&d, "C:\\GAMES\\a.exe"));
        assert!(!is_blocked_path(&d, "C:\\GamesX\\a.exe"));
        assert!(!is_blocked_path(&d, "C:\\Gam"));
    }
}
