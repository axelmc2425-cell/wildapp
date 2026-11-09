//! Persistent store of pushed windows, partner key and open unlock challenges.
//! The helper does not trust app input: every push is validated, and an existing
//! locked/frozen window can only be extended or ended by a partner token.

use serde::{Deserialize, Serialize};

use crate::model::{Lock, Mode, Window};
use crate::unlock::{self, Challenge, UnlockError, CHALLENGE_TTL_MS};

pub const MAX_LOCKED_MS: i64 = 604_800_000;
pub const MAX_FROZEN_MS: i64 = 86_400_000;
/// Most windows accepted in one push, and most stored.
pub const MAX_WINDOWS: usize = 1024;
/// Most sites plus apps in one window.
pub const MAX_ITEMS_PER_WINDOW: usize = 512;
/// Most open (unexpired) unlock challenges.
pub const MAX_CHALLENGES: usize = 32;
/// Current persisted-state format version.
pub const STORE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalid {
    BadTimes,
    BadLock,
    TooLong,
}

impl Invalid {
    /// Same reasons as the JS validateWindow.
    pub fn reason(&self) -> &'static str {
        match self {
            Invalid::BadTimes => "bad-times",
            Invalid::BadLock => "bad-lock",
            Invalid::TooLong => "too-long",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushError {
    NoPartner,
    Invalid(Invalid),
    /// A site or app entry is empty or contains whitespace, control or forbidden characters.
    BadItem,
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
        Some(cap) if w.ends.saturating_sub(w.starts) > cap => Err(Invalid::TooLong),
        _ => Ok(()),
    }
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
            if w.sites.len() + w.apps.len() > MAX_ITEMS_PER_WINDOW {
                return Err(PushError::TooMany);
            }
            if !w.sites.iter().all(|s| good_item(s, true)) || !w.apps.iter().all(|a| good_item(a, false)) {
                return Err(PushError::BadItem);
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
        let w = self
            .windows
            .iter_mut()
            .find(|w| w.id == window_id && is_locking(w))
            .ok_or(UnlockError::WrongLock)?;
        self.challenges[idx].used = true;
        let original_ends = w.ends;
        w.ends = w.ends.min(now_ms);
        // Remember the original end so the app's next re-push cannot bring the lock back.
        self.ended_early.retain(|t| t.id != window_id);
        self.ended_early.push(Tombstone { id: window_id.clone(), ends: original_ends });
        self.high_water_ms = now_ms;
        Ok(window_id)
    }
}
