//! JSON request/response protocol between the app and the helper (one JSON object per line).

use serde::{Deserialize, Serialize};

use crate::clock::EffectiveClock;
use crate::decide::decide;
use crate::lockstore::{ChallengeError, LockStore, PartnerError, PushError};
use crate::model::{Decision, Window};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Request {
    PushWindows { windows: Vec<Window> },
    GetStatus,
    RequestChallenge { window_id: String },
    SubmitToken { token: String },
    SetPartner { public_key: String },
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
    },
    Challenge { code: String },
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
    let now = clock.now(wall_ms, mono_ms);
    let resp = match req {
        Request::PushWindows { windows } => match store.push(windows, now) {
            Ok(_) => Response::Ok,
            Err(PushError::NoPartner) => err("no-partner", "a partner key is required for locked windows"),
            Err(PushError::Invalid(i)) => err("bad-window", i.reason()),
            Err(PushError::BadItem) => err("bad-window", "bad-item"),
        },
        Request::GetStatus => Response::Status {
            decision: decide(&store.windows, now),
            windows: store.windows.clone(),
            partner_set: store.partner_key.is_some(),
            now_ms: now,
            warnings: Vec::new(),
        },
        Request::RequestChallenge { window_id } => match store.request_challenge(&window_id, now, nonce) {
            Ok(code) => Response::Challenge { code },
            Err(ChallengeError::NoSuchLock) => err("no-such-lock", "no active locked window with that id"),
        },
        Request::SubmitToken { token } => match store.submit_token(&token, now) {
            Ok(_) => Response::Ok,
            Err(e) => err(e.reason(), e.reason()),
        },
        Request::SetPartner { public_key } => match store.set_partner(&public_key, now) {
            Ok(()) => Response::Ok,
            Err(PartnerError::BadKey) => err("bad-key", "not a valid P-256 public key"),
            Err(PartnerError::LockActive) => err("lock-active", "cannot change partner while a lock is active"),
        },
    };
    if clock.high_water_ms() > store.high_water_ms {
        store.high_water_ms = clock.high_water_ms();
    }
    resp
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
