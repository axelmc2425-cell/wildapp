//! Persistent store of pushed windows, partner key and open unlock challenges.
//! The helper does not trust app input: every push is validated, and an existing
//! locked/frozen window can only be extended or ended by a partner token.

use serde::{Deserialize, Serialize};

use crate::model::{Lock, Mode, Window};
use crate::unlock::{self, Challenge, UnlockError, CHALLENGE_TTL_MS};

pub const MAX_LOCKED_MS: i64 = 604_800_000;
/// Bounds of a Locked window's unlock delay.
pub const MIN_UNLOCK_DELAY_MS: i64 = 3_600_000;
pub const MAX_UNLOCK_DELAY_MS: i64 = 604_800_000;
pub const MAX_FROZEN_MS: i64 = 86_400_000;
/// Most windows accepted in one push, and most stored.
pub const MAX_WINDOWS: usize = 1024;
/// Most sites, apps and folders in one window.
pub const MAX_ITEMS_PER_WINDOW: usize = 512;
/// Most open (unexpired) unlock challenges.
pub const MAX_CHALLENGES: usize = 32;
/// Current persisted-state format version.
pub const STORE_VERSION: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalid {
    BadTimes,
    BadLock,
    TooLong,
    BadDelay,
}

impl Invalid {
    /// Same reasons as the JS validateWindow.
    pub fn reason(&self) -> &'static str {
        match self {
            Invalid::BadTimes => "bad-times",
            Invalid::BadLock => "bad-lock",
            Invalid::TooLong => "too-long",
            Invalid::BadDelay => "bad-delay",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushError {
    NoPartner,
    Invalid(Invalid),
    /// A site or app entry is empty or contains whitespace, control or forbidden characters.
    BadItem,
    /// A folder is not an absolute drive-letter path, or has control characters, wildcards or `..`.
    BadFolder,
    /// A folder is a drive root, Windows, a Program Files/Users root, or the helper's own folder.
    ForbiddenFolder,
    /// Frozen windows are not available until sub-project 4 (Ruling 17).
    FrozenUnavailable,
    /// An allow-mode window with no apps would terminate every non-critical app.
    AllowNeedsApps,
    /// Too many windows, or too many sites and apps in one window.
    TooMany,
    /// Two windows in one push share an id.
    DuplicateId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartnerError {
    BadKey,
    LockActive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChallengeError {
    NoSuchLock,
    /// Too many open challenges.
    TooMany,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PushReport {
    /// Existing locked/frozen windows retained.
    pub kept: usize,
    /// New windows stored (locked and none).
    pub added: usize,
    /// Old `none` windows replaced or removed.
    pub replaced: usize,
    /// Retained locked windows whose end grew.
    pub extended: usize,
    /// Incoming windows skipped because the partner already ended them early.
    pub tombstoned: usize,
}

/// A window ended early by a partner token. A re-push of the same window (same id, same or
/// earlier end) must not bring the lock back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tombstone {
    pub id: String,
    /// The window's original end.
    pub ends: i64,
}

/// A requested delayed unlock: the window ends early once `unlock_at` (effective ms) passes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingUnlock {
    pub window_id: String,
    pub unlock_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelayError {
    /// No active locked window with that id.
    NoSuchLock,
    /// The window is not a Locked window carrying an unlock delay.
    NotDelayable,
}

fn current_version() -> u32 {
    STORE_VERSION
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LockStore {
    /// Format version; state written before versioning loads as the current one.
    #[serde(default = "current_version")]
    pub version: u32,
    pub windows: Vec<Window>,
    pub partner_key: Option<String>,
    pub challenges: Vec<Challenge>,
    pub high_water_ms: i64,
    pub ended_early: Vec<Tombstone>,
    pub pending_unlocks: Vec<PendingUnlock>,
}

impl Default for LockStore {
    fn default() -> Self {
        LockStore {
            version: STORE_VERSION,
            windows: Vec::new(),
            partner_key: None,
            challenges: Vec::new(),
            high_water_ms: 0,
            ended_early: Vec::new(),
            pending_unlocks: Vec::new(),
        }
    }
}

fn cap_for(lock: Lock) -> Option<i64> {
    match lock {
        Lock::None => None,
        Lock::Locked => Some(MAX_LOCKED_MS),
        Lock::Frozen => Some(MAX_FROZEN_MS),
    }
}

fn validate_window(w: &Window) -> Result<(), Invalid> {
    if w.ends <= w.starts {
        return Err(Invalid::BadTimes);
    }
    match cap_for(w.lock) {
        Some(cap) if w.ends.saturating_sub(w.starts) > cap => return Err(Invalid::TooLong),
        _ => {}
    }
    let delay_ok = match (w.lock, w.unlock_delay_ms) {
        (Lock::Locked, Some(d)) => (MIN_UNLOCK_DELAY_MS..=MAX_UNLOCK_DELAY_MS).contains(&d),
        (Lock::Locked, None) => false,
        (_, d) => d.is_none(),
    };
    if delay_ok { Ok(()) } else { Err(Invalid::BadDelay) }
}

/// Sites are plain host names: no whitespace, control characters, `#`, `/` or `\`.
/// Apps are executable names: spaces are allowed (`League of Legends.exe`) but not other
/// whitespace, control characters, path separators or `:`; blank names are rejected.
/// Mirrors `validateItems` in src/modules/focus/limits.js (shared vectors).
pub fn good_item(s: &str, is_site: bool) -> bool {
    if is_site {
        !s.is_empty() && !s.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '#' | '/' | '\\'))
    } else {
        !s.trim().is_empty()
            && !s.chars().any(|c| {
                c.is_control() || (c.is_whitespace() && c != ' ') || matches!(c, '/' | '\\' | ':')
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderProblem {
    Malformed,
    Forbidden,
}

/// Checks a blocked-folder value: an absolute path with a drive letter (`C:\Games\Foo`), no
/// control characters, wildcards, `.`/`..` or empty segments, a single trailing `\` allowed.
/// Then refuses folders that must never be blocked (drive root, Windows, Program Files and
/// Users themselves, the helper's install folder). The forbidden comparison normalizes `/` to
/// `\` and ASCII-lowercases; the stored value is untouched.
/// Mirrors `folderProblem` in src/modules/focus/folders.js (shared vectors).
pub fn folder_problem(s: &str) -> Option<FolderProblem> {
    if s.chars().any(|c| c.is_control() || matches!(c, '*' | '?' | '<' | '>' | '|' | '"')) {
        return Some(FolderProblem::Malformed);
    }
    let n = s.replace('/', "\\").to_ascii_lowercase();
    let b = n.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
        return Some(FolderProblem::Malformed);
    }
    let rest = n[3..].strip_suffix('\\').unwrap_or(&n[3..]);
    let segs: Vec<&str> = if rest.is_empty() { Vec::new() } else { rest.split('\\').collect() };
    if segs.iter().any(|g| g.is_empty() || *g == "." || *g == ".." || g.contains(':')) {
        return Some(FolderProblem::Malformed);
    }
    let forbidden = match segs.as_slice() {
        [] => true,
        ["windows", ..] => true,
        ["program files"] | ["program files (x86)"] | ["users"] => true,
        ["program files", "mybrainfocus", ..] => true,
        _ => false,
    };
    forbidden.then_some(FolderProblem::Forbidden)
}

fn is_locking(w: &Window) -> bool {
    w.lock != Lock::None
}

fn is_active(w: &Window, now_ms: i64) -> bool {
    w.starts <= now_ms && now_ms < w.ends
}

impl LockStore {
    /// Drops tombstones whose original end has passed.
    pub fn prune_tombstones(&mut self, now_ms: i64) {
        self.ended_early.retain(|t| t.ends > now_ms);
    }

    pub fn push(&mut self, incoming: Vec<Window>, now_ms: i64) -> Result<PushReport, PushError> {
        // Never trust the caller's clock to go backwards.
        let now_ms = now_ms.max(self.high_water_ms);
        // Validate everything first so a rejected push changes nothing.
        if incoming.len() > MAX_WINDOWS {
            return Err(PushError::TooMany);
        }
        let mut seen = std::collections::HashSet::new();
        for w in &incoming {
            if w.lock == Lock::Frozen {
                return Err(PushError::FrozenUnavailable);
            }
            if w.sites.len() + w.apps.len() + w.app_folders.len() > MAX_ITEMS_PER_WINDOW {
                return Err(PushError::TooMany);
            }
            if !w.sites.iter().all(|s| good_item(s, true)) || !w.apps.iter().all(|a| good_item(a, false)) {
                return Err(PushError::BadItem);
            }
            let problems: Vec<FolderProblem> = w.app_folders.iter().filter_map(|f| folder_problem(f)).collect();
            if problems.contains(&FolderProblem::Malformed) {
                return Err(PushError::BadFolder);
            }
            if !problems.is_empty() {
                return Err(PushError::ForbiddenFolder);
            }
            if w.mode == Mode::Allow && w.apps.is_empty() {
                return Err(PushError::AllowNeedsApps);
            }
            validate_window(w).map_err(PushError::Invalid)?;
            if is_locking(w) && self.partner_key.is_none() {
                return Err(PushError::NoPartner);
            }
            if !seen.insert(w.id.as_str()) {
                return Err(PushError::DuplicateId);
            }
        }

        let tombstones: Vec<Tombstone> =
            self.ended_early.iter().filter(|t| t.ends > now_ms).cloned().collect();
        let mut kept: Vec<Window> =
            self.windows.iter().filter(|w| is_locking(w) && w.ends > now_ms).cloned().collect();
        let mut report = PushReport { kept: kept.len(), ..PushReport::default() };

        // Extensions of retained windows (cap measured from the stored start); checked before applying.
        for w in incoming.iter().filter(|w| is_locking(w)) {
            if let Some(old) = kept.iter().find(|k| k.id == w.id) {
                if w.ends > old.ends {
                    let cap = cap_for(old.lock).unwrap_or(i64::MAX);
                    if w.ends.saturating_sub(old.starts) > cap {
                        return Err(PushError::Invalid(Invalid::TooLong));
                    }
                }
            }
        }

        let mut fresh: Vec<Window> = Vec::new();
        let mut extended = 0;
        let mut extend_to: Vec<(usize, i64)> = Vec::new();
        for w in incoming {
            if w.ends <= now_ms {
                continue;
            }
            if let Some(i) = kept.iter().position(|k| k.id == w.id) {
                if is_locking(&w) && w.ends > kept[i].ends {
                    extend_to.push((i, w.ends));
                    extended += 1;
                }
                continue; // other fields of an existing locked window are ignored
            }
            if tombstones.iter().any(|t| t.id == w.id && w.ends <= t.ends) {
                report.tombstoned += 1;
                continue;
            }
            report.added += 1;
            fresh.push(w);
        }
        if kept.len() + fresh.len() > MAX_WINDOWS {
            return Err(PushError::TooMany);
        }
        for (i, ends) in extend_to {
            kept[i].ends = ends;
        }
        report.extended = extended;

        report.replaced = self.windows.iter().filter(|w| !is_locking(w)).count();
        kept.extend(fresh);
        self.windows = kept;
        self.ended_early = tombstones;
        self.high_water_ms = now_ms;
        Ok(report)
    }

    pub fn set_partner(&mut self, public_key_b64: &str, now_ms: i64) -> Result<(), PartnerError> {
        let now_ms = now_ms.max(self.high_water_ms);
        self.high_water_ms = now_ms;
        if unlock::parse_public_key(public_key_b64).is_none() {
            return Err(PartnerError::BadKey);
        }
        if self.windows.iter().any(|w| is_locking(w) && w.ends > now_ms) {
            return Err(PartnerError::LockActive);
        }
        self.partner_key = Some(public_key_b64.to_string());
        Ok(())
    }

    pub fn request_challenge(
        &mut self,
        window_id: &str,
        now_ms: i64,
        nonce: [u8; 16],
    ) -> Result<String, ChallengeError> {
        let now_ms = now_ms.max(self.high_water_ms);
        self.high_water_ms = now_ms;
        let ok = self.windows.iter().any(|w| w.id == window_id && is_locking(w) && is_active(w, now_ms));
        if !ok {
            return Err(ChallengeError::NoSuchLock);
        }
        self.challenges.retain(|c| now_ms - c.issued <= CHALLENGE_TTL_MS);
        if self.challenges.len() >= MAX_CHALLENGES {
            return Err(ChallengeError::TooMany);
        }
        let nonce = unlock::b64u_encode(&nonce);
        let code = unlock::challenge_code(&nonce, window_id);
        self.challenges.push(Challenge {
            nonce,
            window_id: window_id.to_string(),
            issued: now_ms,
            used: false,
        });
        Ok(code)
    }

    /// Verifies a partner token against its open challenge and ends that window now.
    /// Returns the window id. Nothing is mutated on failure.
    pub fn submit_token(&mut self, token: &str, now_ms: i64) -> Result<String, UnlockError> {
        let now_ms = now_ms.max(self.high_water_ms);
        let key = self.partner_key.clone();
        let parsed = unlock::parse_token(token)?;
        let idx = self.challenges.iter().position(|c| c.nonce == parsed.nonce);
        let key = key.as_deref().unwrap_or("");
        let idx = match idx {
            Some(i) => i,
            None => {
                // Unknown nonce: still report bad-signature before wrong-challenge, like verify.
                let probe = Challenge { nonce: String::new(), window_id: String::new(), issued: now_ms, used: false };
                return Err(match unlock::verify(key, token, &probe, now_ms) {
                    Err(UnlockError::WrongChallenge) | Ok(()) => UnlockError::WrongChallenge,
                    Err(e) => e,
                });
            }
        };
        unlock::verify(key, token, &self.challenges[idx], now_ms)?;

        let window_id = self.challenges[idx].window_id.clone();
        if !self.end_early(&window_id, now_ms) {
            return Err(UnlockError::WrongLock);
        }
        self.challenges[idx].used = true;
        self.high_water_ms = now_ms;
        Ok(window_id)
    }

    /// Ends a locking window now (`ends = min(ends, now)`), remembers its original end so a
    /// re-push cannot bring it back, and drops any pending delayed unlock for it.
    /// Returns false (changing nothing) when there is no such locking window that is still
    /// active: an already-ended window keeps its existing tombstone.
    fn end_early(&mut self, window_id: &str, now_ms: i64) -> bool {
        let Some(w) = self.windows.iter_mut().find(|w| w.id == window_id && is_locking(w) && is_active(w, now_ms)) else {
            return false;
        };
        let original_ends = w.ends;
        w.ends = w.ends.min(now_ms);
        self.ended_early.retain(|t| t.id != window_id);
        self.ended_early.push(Tombstone { id: window_id.to_string(), ends: original_ends });
        self.pending_unlocks.retain(|p| p.window_id != window_id);
        true
    }

    /// Starts the waiting period of a Locked window; returns when it ends. A repeat request
    /// returns the existing time rather than restarting the wait.
    pub fn request_delayed_unlock(&mut self, window_id: &str, now_ms: i64) -> Result<i64, DelayError> {
        let now_ms = now_ms.max(self.high_water_ms);
        self.high_water_ms = now_ms;
        let w = self
            .windows
            .iter()
            .find(|w| w.id == window_id && is_active(w, now_ms))
            .ok_or(DelayError::NoSuchLock)?;
        let delay = match (w.lock, w.unlock_delay_ms) {
            (Lock::Locked, Some(d)) => d,
            _ => return Err(DelayError::NotDelayable),
        };
        if let Some(p) = self.pending_unlocks.iter().find(|p| p.window_id == window_id) {
            return Ok(p.unlock_at);
        }
        let unlock_at = now_ms.saturating_add(delay);
        self.pending_unlocks.push(PendingUnlock { window_id: window_id.to_string(), unlock_at });
        Ok(unlock_at)
    }

    /// Abandons a pending delayed unlock; false when there was none.
    pub fn cancel_delayed_unlock(&mut self, window_id: &str) -> bool {
        let before = self.pending_unlocks.len();
        self.pending_unlocks.retain(|p| p.window_id != window_id);
        self.pending_unlocks.len() != before
    }

    /// Applies pending unlocks that are due: the window ends now. A pending entry whose window
    /// is gone or already over is just dropped. Returns true when anything changed.
    pub fn expire_pending(&mut self, now_ms: i64) -> bool {
        let now_ms = now_ms.max(self.high_water_ms);
        let pending = std::mem::take(&mut self.pending_unlocks);
        let mut changed = false;
        for p in pending {
            let live = self.windows.iter().any(|w| w.id == p.window_id && is_locking(w) && w.ends > now_ms);
            if !live {
                changed = true;
            } else if p.unlock_at <= now_ms {
                self.end_early(&p.window_id, now_ms);
                changed = true;
            } else {
                self.pending_unlocks.push(p);
            }
        }
        changed
    }
}

#[cfg(test)]
mod folder_tests {
    use super::*;
    use crate::model::Mode;

    const NOW: i64 = 1_700_000_000_000;
    const H: i64 = 3_600_000;

    fn win(id: &str, lock: Lock) -> Window {
        Window {
            id: id.into(),
            starts: NOW - H,
            ends: NOW + H,
            lock,
            mode: Mode::Block,
            sites: vec![],
            apps: vec![],
            app_folders: vec![],
            unlock_delay_ms: if lock == Lock::Locked { Some(86_400_000) } else { None },
        }
    }

    fn with_folders(folders: &[&str]) -> Window {
        let mut w = win("w", Lock::None);
        w.app_folders = folders.iter().map(|s| s.to_string()).collect();
        w
    }

    fn vectors() -> serde_json::Value {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/folder-vectors.json");
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn folder_vectors_match_fixture() {
        let v = vectors();
        for (key, want) in [
            ("ok", None),
            ("malformed", Some(FolderProblem::Malformed)),
            ("forbidden", Some(FolderProblem::Forbidden)),
        ] {
            let list = v[key].as_array().unwrap();
            assert!(!list.is_empty(), "{key}");
            for s in list {
                let s = s.as_str().unwrap();
                assert_eq!(folder_problem(s), want, "{key}: {s:?}");
            }
        }
    }

    #[test]
    fn push_rejects_bad_folder() {
        let mut s = LockStore::default();
        assert_eq!(s.push(vec![with_folders(&["Games"])], NOW), Err(PushError::BadFolder));
        assert!(s.windows.is_empty());
    }

    #[test]
    fn push_rejects_forbidden_folder() {
        let mut s = LockStore::default();
        assert_eq!(s.push(vec![with_folders(&["C:\\Windows"])], NOW), Err(PushError::ForbiddenFolder));
        // malformed is reported before forbidden
        assert_eq!(
            s.push(vec![with_folders(&["C:\\Windows", "Games"])], NOW),
            Err(PushError::BadFolder)
        );
        assert!(s.push(vec![with_folders(&["C:\\Games\\Steam"])], NOW).is_ok());
    }

    #[test]
    fn folders_count_toward_item_cap() {
        let mut w = win("w", Lock::None);
        w.sites = (0..200).map(|i| format!("s{i}.com")).collect();
        w.apps = (0..200).map(|i| format!("a{i}.exe")).collect();
        w.app_folders = (0..113).map(|i| format!("C:\\Games\\g{i}")).collect();
        let mut s = LockStore::default();
        assert_eq!(s.push(vec![w.clone()], NOW), Err(PushError::TooMany));
        w.app_folders.pop();
        assert!(s.push(vec![w], NOW).is_ok());
    }

    #[test]
    fn old_state_without_app_folders_loads() {
        let json = r#"{"version":2,"windows":[{"id":"w","starts":1,"ends":2,"lock":"none","mode":"block","sites":["a.com"],"apps":[]}]}"#;
        let s: LockStore = serde_json::from_str(json).unwrap();
        assert_eq!(s.windows.len(), 1);
        assert!(s.windows[0].app_folders.is_empty());
        assert_eq!(STORE_VERSION, 3);
        // empty folders are not serialized
        assert!(!serde_json::to_string(&s.windows[0]).unwrap().contains("app_folders"));
    }

    #[test]
    fn locked_window_folders_ignored_on_repush() {
        let (_, pk) = {
            use crate::unlock::b64u_encode;
            use p256::ecdsa::SigningKey;
            let sk = SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
            let pk = b64u_encode(sk.verifying_key().to_encoded_point(false).as_bytes());
            (sk, pk)
        };
        let mut s = LockStore::default();
        s.set_partner(&pk, NOW).unwrap();
        let mut w = win("L", Lock::Locked);
        w.app_folders = vec!["C:\\Games\\One".into()];
        s.push(vec![w.clone()], NOW).unwrap();
        w.app_folders = vec!["C:\\Games\\Two".into()];
        s.push(vec![w], NOW).unwrap();
        assert_eq!(s.windows[0].app_folders, vec!["C:\\Games\\One".to_string()]);
    }
}
