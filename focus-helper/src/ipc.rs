//! JSON request/response protocol between the app and the helper (one JSON object per line).

use serde::{Deserialize, Serialize};

use crate::clock::EffectiveClock;
use crate::decide::decide;
use crate::lockstore::{ChallengeError, DelayError, LockStore, PendingUnlock, PartnerError, PushError};
use crate::model::{Decision, Window};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Request {
    PushWindows { windows: Vec<Window> },
    GetStatus,
    RequestChallenge { window_id: String },
    SubmitToken { token: String },
    /// Starts the waiting period of a Locked window; answered with `UnlockPending`.
    RequestDelayedUnlock { window_id: String },
    CancelDelayedUnlock { window_id: String },
    SetPartner { public_key: String },
    /// Recovery from a bogus far-future clock: refused while any lock is pending.
    ResetClock,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Response {
    Ok,
    Status { decision: Decision, windows: Vec<Window>, partner_set: bool,
        now_ms: i64,
        /// Enforcement problems reported by the daemon (always present, possibly empty).
        #[serde(default)]
        warnings: Vec<String>,
        /// Delayed unlocks waiting to expire.
        #[serde(default)]
        pending_unlocks: Vec<PendingUnlock>,
    },
    Challenge { code: String },
    /// The window ends early at `unlock_at` (effective ms) unless cancelled.
    UnlockPending { unlock_at: i64 },
    /// Codes: bad-request, no-partner, bad-window (bad-times, bad-lock, too-long, bad-item, bad-folder,
    /// forbidden-folder, allow-needs-apps, too-many, duplicate id, bad-delay), frozen-unavailable, too-many, no-such-lock, not-delayable,
    /// no-pending-unlock, bad-key, lock-active (also ResetClock), the unlock
    /// reasons, and `persist-failed` (daemon only: applied in memory but the state file could not
    /// be written, so the change is lost on restart; retried every tick).
    Error { code: String, message: String },
}

fn err(code: &str, message: impl Into<String>) -> Response {
    Response::Error { code: code.to_string(), message: message.into() }
}

pub fn handle(
    store: &mut LockStore,
    clock: &mut EffectiveClock,
    req: Request,
    wall_ms: i64,
    mono_ms: i64,
    nonce: [u8; 16],
) -> Response {
    handle_changed(store, clock, req, wall_ms, mono_ms, nonce).0
}

/// Like `handle`; the flag is true when processing due delayed unlocks changed the store.
pub fn handle_changed(
    store: &mut LockStore,
    clock: &mut EffectiveClock,
    req: Request,
    wall_ms: i64,
    mono_ms: i64,
    nonce: [u8; 16],
) -> (Response, bool) {
    let now = clock.now(wall_ms, mono_ms);
    let expired = store.expire_pending(now);
    let resp = match req {
        Request::PushWindows { windows } => match store.push(windows, now) {
            Ok(_) => Response::Ok,
            Err(PushError::NoPartner) => err("no-partner", "a partner key is required for locked windows"),
            Err(PushError::Invalid(i)) => err("bad-window", i.reason()),
            Err(PushError::BadItem) => err("bad-window", "bad-item"),
            Err(PushError::FrozenUnavailable) => {
                err("frozen-unavailable", "frozen windows are not available in this version")
            }
            Err(PushError::BadFolder) => err("bad-window", "bad-folder"),
            Err(PushError::ForbiddenFolder) => err("bad-window", "forbidden-folder"),
            Err(PushError::AllowNeedsApps) => err("bad-window", "allow-needs-apps"),
            Err(PushError::TooMany) => err("bad-window", "too-many"),
            Err(PushError::DuplicateId) => err("bad-window", "duplicate id"),
        },
        Request::GetStatus => Response::Status {
            decision: decide(&store.windows, now),
            windows: store.windows.clone(),
            partner_set: store.partner_key.is_some(),
            now_ms: now,
            warnings: Vec::new(),
            pending_unlocks: store.pending_unlocks.clone(),
        },
        Request::RequestChallenge { window_id } => match store.request_challenge(&window_id, now, nonce) {
            Ok(code) => Response::Challenge { code },
            Err(ChallengeError::NoSuchLock) => err("no-such-lock", "no active locked window with that id"),
            Err(ChallengeError::TooMany) => err("too-many", "too many open unlock challenges; wait for older ones to expire"),
        },
        Request::SubmitToken { token } => match store.submit_token(&token, now) {
            Ok(_) => Response::Ok,
            Err(e) => err(e.reason(), e.reason()),
        },
        Request::RequestDelayedUnlock { window_id } => match store.request_delayed_unlock(&window_id, now) {
            Ok(unlock_at) => Response::UnlockPending { unlock_at },
            Err(DelayError::NoSuchLock) => err("no-such-lock", "no active locked window with that id"),
            Err(DelayError::NotDelayable) => err("not-delayable", "that window has no unlock delay"),
        },
        Request::CancelDelayedUnlock { window_id } => {
            if store.cancel_delayed_unlock(&window_id) {
                Response::Ok
            } else {
                err("no-pending-unlock", "no delayed unlock is pending for that window")
            }
        }
        Request::ResetClock => {
            if store.windows.iter().any(|w| w.lock != crate::model::Lock::None && w.ends > now) {
                err("lock-active", "cannot reset the clock while a lock is active or scheduled")
            } else {
                clock.reset(wall_ms, mono_ms);
                store.high_water_ms = wall_ms;
                store.challenges.clear();
                store.pending_unlocks.clear();
                Response::Ok
            }
        }
        Request::SetPartner { public_key } => match store.set_partner(&public_key, now) {
            Ok(()) => Response::Ok,
            Err(PartnerError::BadKey) => err("bad-key", "not a valid P-256 public key"),
            Err(PartnerError::LockActive) => err("lock-active", "cannot change partner while a lock is active"),
        },
    };
    if clock.high_water_ms() > store.high_water_ms {
        store.high_water_ms = clock.high_water_ms();
    }
    (resp, expired)
}

pub fn handle_line(
    store: &mut LockStore,
    clock: &mut EffectiveClock,
    line: &str,
    wall_ms: i64,
    mono_ms: i64,
    nonce: [u8; 16],
) -> String {
    let resp = match serde_json::from_str::<Request>(line) {
        Ok(req) => handle(store, clock, req, wall_ms, mono_ms, nonce),
        Err(e) => err("bad-request", e.to_string()),
    };
    serde_json::to_string(&resp).unwrap_or_else(|_| {
        r#"{"type":"Error","code":"bad-request","message":"serialize failed"}"#.to_string()
    })
}
