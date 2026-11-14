//! Process enforcement: decide which running processes to terminate. Portable; the
//! Windows process table lives in `win::procs`. The caller re-checks about once a second.
use crate::decide::{is_blocked_app, is_blocked_path, normalize_app, CRITICAL_APPS};
use crate::model::Decision;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    /// Full image path when readable; `None` never matches a folder rule.
    pub path: Option<String>,
}

pub trait ProcessTable {
    fn list(&self) -> Vec<Proc>;
    fn kill(&self, pid: u32) -> bool;
}

/// Common VPN and proxy apps, blocked as friction while any block window is active.
pub const VPN_APPS: &[&str] = &[
    "openvpn.exe", "nordvpn.exe", "expressvpn.exe", "protonvpn.exe", "windscribe.exe",
    "mullvad-vpn.exe", "surfshark.exe", "tor.exe", "psiphon3.exe", "cloudflare-warp.exe",
];

/// A decision has an active block window when it blocks any site, app or folder, is frozen, or has
/// an allow-list. An entirely empty decision has none, so nothing (VPNs included) is killed.
pub fn any_window_active(d: &Decision) -> bool {
    !d.block_sites.is_empty()
        || !d.block_apps.is_empty()
        || !d.block_folders.is_empty()
        || d.frozen
        || d.allow.is_some()
}

/// Empty, whitespace-only and placeholder names (sysinfo reports `<no name> ...` when a
/// process name cannot be read) are never killed: we cannot tell what they are.
pub fn is_killable_name(name: &str) -> bool {
    let t = name.trim();
    !t.is_empty() && !t.starts_with('<')
}

/// Terminates and returns every blocked process. Never touches `self_pid`, pid 0/4 or any
/// CRITICAL_APPS entry; that guard is enforced here independently of `is_blocked_app`.
pub fn enforce_once(d: &Decision, table: &dyn ProcessTable, self_pid: u32) -> Vec<Proc> {
    enforce_with(d, table, self_pid, any_window_active(d))
}

/// Like `enforce_once`, with the VPN friction decided by the caller. `friction` must come from
/// block WINDOWS only: a used-up time limit adds its apps and sites to `d` but must not turn on
/// the VPN kill. Nothing is killed when `d` has no blocks and `friction` is off.
pub fn enforce_with(d: &Decision, table: &dyn ProcessTable, self_pid: u32, friction: bool) -> Vec<Proc> {
    if !friction && d.block_apps.is_empty() && d.block_folders.is_empty() {
        return Vec::new();
    }
    let mut killed = Vec::new();
    for p in table.list() {
        if p.pid == 0 || p.pid == 4 || p.pid == self_pid {
            continue;
        }
        if !is_killable_name(&p.name) {
            continue;
        }
        let n = normalize_app(&p.name);
        if CRITICAL_APPS.iter().any(|c| normalize_app(c) == n) {
            continue;
        }
        let blocked = is_blocked_app(d, &p.name)
            || (friction && VPN_APPS.iter().any(|v| *v == n))
            || p.path.as_deref().map_or(false, |x| is_blocked_path(d, x));
        if blocked && table.kill(p.pid) {
            killed.push(p);
        }
    }
    killed
}
