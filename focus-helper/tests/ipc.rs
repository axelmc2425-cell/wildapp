use focus_helper::clock::EffectiveClock;
use focus_helper::ipc::{handle, handle_line, Request, Response};
use focus_helper::lockstore::LockStore;
use focus_helper::model::{Lock, Mode, Window};
use serde_json::{json, Value};

const NOW: i64 = 1_700_000_000_000;

fn vector() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/unlock-vectors.json");
    let v: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    v.into_iter().find(|x| x["name"] == "valid").unwrap()
}

fn win(id: &str, lock: Lock, starts: i64, ends: i64) -> Window {
    Window { id: id.into(), starts, ends, lock, mode: Mode::Block, sites: vec!["x.com".into()], apps: vec![], app_folders: vec![], unlock_delay_ms: if lock == Lock::Locked { Some(86_400_000) } else { None } }
}

fn run(s: &mut LockStore, c: &mut EffectiveClock, r: Request) -> Response {
    handle(s, c, r, NOW, 0, [0; 16])
}

fn code_of(r: Response) -> String {
    match r {
        Response::Error { code, .. } => code,
        other => panic!("expected error, got {other:?}"),
    }
}

fn setup() -> (LockStore, EffectiveClock) {
    (LockStore::default(), EffectiveClock::new(0))
}

fn with_partner() -> (LockStore, EffectiveClock) {
    let (mut s, mut c) = setup();
    let key = vector()["publicKey"].as_str().unwrap().to_string();
    assert_eq!(run(&mut s, &mut c, Request::SetPartner { public_key: key }), Response::Ok);
    (s, c)
}

#[test]
fn request_json_round_trip() {
    let reqs = vec![
        Request::PushWindows { windows: vec![win("a", Lock::Locked, 1, 2)] },
        Request::GetStatus,
        Request::RequestChallenge { window_id: "a".into() },
        Request::SubmitToken { token: "t".into() },
        Request::SetPartner { public_key: "k".into() },
        Request::RequestDelayedUnlock { window_id: "a".into() },
        Request::CancelDelayedUnlock { window_id: "a".into() },
    ];
    for r in reqs {
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<Request>(&s).unwrap(), r);
    }
    assert_eq!(serde_json::to_value(Request::GetStatus).unwrap(), json!({"type":"GetStatus"}));
    assert_eq!(
        serde_json::to_value(Request::RequestChallenge { window_id: "a".into() }).unwrap(),
        json!({"type":"RequestChallenge","window_id":"a"})
    );
}

#[test]
fn push_without_partner_errors() {
    let (mut s, mut c) = setup();
    let r = run(&mut s, &mut c, Request::PushWindows { windows: vec![win("a", Lock::Locked, NOW - 1, NOW + 1000)] });
    assert_eq!(code_of(r), "no-partner");
}

#[test]
fn push_none_window_ok_and_bad_window() {
    let (mut s, mut c) = setup();
    assert_eq!(
        run(&mut s, &mut c, Request::PushWindows { windows: vec![win("a", Lock::None, NOW - 1, NOW + 1000)] }),
        Response::Ok
    );
    let r = run(&mut s, &mut c, Request::PushWindows { windows: vec![win("b", Lock::None, 5, 5)] });
    match r {
        Response::Error { code, message } => {
            assert_eq!(code, "bad-window");
            assert_eq!(message, "bad-times");
        }
        o => panic!("{o:?}"),
    }
    let mut w = win("c", Lock::None, 1, 2);
    w.sites = vec!["bad host".into()];
    assert_eq!(code_of(run(&mut s, &mut c, Request::PushWindows { windows: vec![w] })), "bad-window");
}

#[test]
fn set_partner_errors() {
    let (mut s, mut c) = setup();
    assert_eq!(code_of(run(&mut s, &mut c, Request::SetPartner { public_key: "nope".into() })), "bad-key");
    let (mut s, mut c) = with_partner();
    run(&mut s, &mut c, Request::PushWindows { windows: vec![win("a", Lock::Locked, NOW - 1, NOW + 100_000)] });
    let key = vector()["publicKey"].as_str().unwrap().to_string();
    assert_eq!(code_of(run(&mut s, &mut c, Request::SetPartner { public_key: key })), "lock-active");
}

#[test]
fn challenge_and_status() {
    let (mut s, mut c) = with_partner();
    assert_eq!(code_of(run(&mut s, &mut c, Request::RequestChallenge { window_id: "zz".into() })), "no-such-lock");
    run(&mut s, &mut c, Request::PushWindows { windows: vec![win("a", Lock::Locked, NOW - 1, NOW + 100_000)] });
    match run(&mut s, &mut c, Request::RequestChallenge { window_id: "a".into() }) {
        Response::Challenge { code } => assert!(!code.is_empty()),
        o => panic!("{o:?}"),
    }
    match run(&mut s, &mut c, Request::GetStatus) {
        Response::Status { decision, windows, partner_set, now_ms, .. } => {
            assert_eq!(decision.block_sites, vec!["x.com".to_string()]);
            assert_eq!(windows.len(), 1);
            assert!(partner_set);
            assert_eq!(now_ms, NOW);
        }
        o => panic!("{o:?}"),
    }
}

#[test]
fn clock_high_water_copied_to_store() {
    let (mut s, mut c) = setup();
    run(&mut s, &mut c, Request::GetStatus);
    assert_eq!(s.high_water_ms, NOW);
    // wall clock set back: effective time does not go back
    match handle(&mut s, &mut c, Request::GetStatus, NOW - 5_000_000, 1000, [0; 16]) {
        Response::Status { now_ms, .. } => assert!(now_ms >= NOW),
        o => panic!("{o:?}"),
    }
}

#[test]
fn submit_token_errors_and_success() {
    let (mut s, mut c) = with_partner();
    assert_eq!(code_of(run(&mut s, &mut c, Request::SubmitToken { token: "garbage".into() })), "bad-format");
    // Valid vector: window win-1, nonce bytes 0..16, token verified at NOW.
    let v = vector();
    let token = v["token"].as_str().unwrap().to_string();
    let nonce: [u8; 16] = core::array::from_fn(|i| i as u8);
    let early = 1_699_999_999_000;
    run(&mut s, &mut c, Request::PushWindows { windows: vec![] });
    s.windows.push(win("win-1", Lock::Locked, early - 1000, NOW + 1_000_000));
    let r = handle(&mut s, &mut c, Request::RequestChallenge { window_id: "win-1".into() }, early, 0, nonce);
    assert!(matches!(r, Response::Challenge { .. }), "{r:?}");
    assert_eq!(handle(&mut s, &mut c, Request::SubmitToken { token: token.clone() }, NOW, 1000, [0; 16]), Response::Ok);
    assert_eq!(s.windows[0].ends, NOW + 1000); // effective time: wall + 1s monotonic
    assert_eq!(code_of(handle(&mut s, &mut c, Request::SubmitToken { token }, NOW, 2000, [0; 16])), "used");
}

#[test]
fn handle_line_bad_requests() {
    let (mut s, mut c) = setup();
    for line in ["not json", "{}", r#"{"type":"Nope"}"#, r#"{"type":"SubmitToken"}"#, ""] {
        let out = handle_line(&mut s, &mut c, line, NOW, 0, [0; 16]);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["type"], "Error");
        assert_eq!(v["code"], "bad-request");
    }
}

#[test]
fn full_conversation() {
    let (mut s, mut c) = setup();
    let v = vector();
    let id = v["challenge"]["windowId"].as_str().unwrap();
    let mut call = |line: Value| -> Value {
        let out = handle_line(&mut s, &mut c, &line.to_string(), NOW, 0, [9; 16]);
        serde_json::from_str(&out).unwrap()
    };
    assert_eq!(call(json!({"type":"SetPartner","public_key":v["publicKey"]})), json!({"type":"Ok"}));
    let w = json!({"id":id,"starts":NOW-1000,"ends":NOW+3_600_000,"lock":"locked","mode":"block","sites":["news.com"],"apps":[],"unlock_delay_ms":86400000});
    assert_eq!(call(json!({"type":"PushWindows","windows":[w.clone()]})), json!({"type":"Ok"}));
    let ch = call(json!({"type":"RequestChallenge","window_id":id}));
    assert_eq!(ch["type"], "Challenge");
    assert!(ch["code"].as_str().unwrap().len() > 0);
    let st = call(json!({"type":"GetStatus"}));
    assert_eq!(st["type"], "Status");
    assert_eq!(st["windows"], json!([w]));
    assert_eq!(st["partner_set"], true);
    assert_eq!(st["now_ms"], NOW);
    assert_eq!(st["decision"]["blockSites"], json!(["news.com"]));
    // empty push leaves the locked window
    assert_eq!(call(json!({"type":"PushWindows","windows":[]})), json!({"type":"Ok"}));
    let st = call(json!({"type":"GetStatus"}));
    assert_eq!(st["windows"], json!([w]));
}

#[test]
fn final_wave_error_codes() {
    let (mut s, mut c) = with_partner();
    let msg = |r: Response| match r {
        Response::Error { code, message } => (code, message),
        o => panic!("{o:?}"),
    };
    let r = run(&mut s, &mut c, Request::PushWindows { windows: vec![win("f", Lock::Frozen, NOW - 1, NOW + 1000)] });
    assert_eq!(msg(r).0, "frozen-unavailable");
    let mut w = win("a", Lock::None, NOW - 1, NOW + 1000);
    w.mode = Mode::Allow;
    let r = run(&mut s, &mut c, Request::PushWindows { windows: vec![w] });
    assert_eq!(msg(r), ("bad-window".to_string(), "allow-needs-apps".to_string()));
    let dup = vec![win("d", Lock::None, NOW - 1, NOW + 1000), win("d", Lock::Locked, NOW - 1, NOW + 1000)];
    let r = run(&mut s, &mut c, Request::PushWindows { windows: dup });
    assert_eq!(msg(r), ("bad-window".to_string(), "duplicate id".to_string()));
    let many: Vec<Window> = (0..1025).map(|i| win(&format!("w{i}"), Lock::None, NOW - 1, NOW + 1000)).collect();
    let r = run(&mut s, &mut c, Request::PushWindows { windows: many });
    assert_eq!(msg(r), ("bad-window".to_string(), "too-many".to_string()));
    run(&mut s, &mut c, Request::PushWindows { windows: vec![win("l", Lock::Locked, NOW - 1, NOW + 100_000)] });
    for _ in 0..32 {
        assert!(matches!(run(&mut s, &mut c, Request::RequestChallenge { window_id: "l".into() }), Response::Challenge { .. }));
    }
    assert_eq!(code_of(run(&mut s, &mut c, Request::RequestChallenge { window_id: "l".into() })), "too-many");
}

const DAY: i64 = 86_400_000;

fn locked_with_pending() -> (LockStore, EffectiveClock) {
    let (mut s, mut c) = with_partner();
    assert_eq!(run(&mut s, &mut c, Request::PushWindows { windows: vec![win("a", Lock::Locked, NOW - 1, NOW + 2 * DAY)] }), Response::Ok);
    (s, c)
}

#[test]
fn delayed_unlock_json_shapes() {
    assert_eq!(
        serde_json::to_value(Request::RequestDelayedUnlock { window_id: "a".into() }).unwrap(),
        json!({"type":"RequestDelayedUnlock","window_id":"a"})
    );
    assert_eq!(
        serde_json::to_value(Request::CancelDelayedUnlock { window_id: "a".into() }).unwrap(),
        json!({"type":"CancelDelayedUnlock","window_id":"a"})
    );
    let r = Response::UnlockPending { unlock_at: 5 };
    assert_eq!(serde_json::to_value(&r).unwrap(), json!({"type":"UnlockPending","unlock_at":5}));
    assert_eq!(serde_json::from_value::<Response>(json!({"type":"UnlockPending","unlock_at":5})).unwrap(), r);
}

#[test]
fn request_cancel_and_status_carry_pending() {
    let (mut s, mut c) = locked_with_pending();
    assert_eq!(run(&mut s, &mut c, Request::RequestDelayedUnlock { window_id: "a".into() }), Response::UnlockPending { unlock_at: NOW + DAY });
    match run(&mut s, &mut c, Request::GetStatus) {
        Response::Status { pending_unlocks, .. } => {
            assert_eq!(pending_unlocks.len(), 1);
            assert_eq!((pending_unlocks[0].window_id.as_str(), pending_unlocks[0].unlock_at), ("a", NOW + DAY));
        }
        o => panic!("{o:?}"),
    }
    assert_eq!(run(&mut s, &mut c, Request::CancelDelayedUnlock { window_id: "a".into() }), Response::Ok);
    assert_eq!(code_of(run(&mut s, &mut c, Request::CancelDelayedUnlock { window_id: "a".into() })), "no-pending-unlock");
    assert_eq!(code_of(run(&mut s, &mut c, Request::RequestDelayedUnlock { window_id: "zz".into() })), "no-such-lock");
    run(&mut s, &mut c, Request::PushWindows { windows: vec![win("n", Lock::None, NOW - 1, NOW + 1000)] });
    assert_eq!(code_of(run(&mut s, &mut c, Request::RequestDelayedUnlock { window_id: "n".into() })), "not-delayable");
}

#[test]
fn wall_clock_moved_back_does_not_shorten_wait() {
    let (mut s, mut c) = locked_with_pending();
    handle(&mut s, &mut c, Request::RequestDelayedUnlock { window_id: "a".into() }, NOW, 0, [0; 16]);
    // wall clock set back two days; only an hour of monotonic time has passed
    handle(&mut s, &mut c, Request::GetStatus, NOW - 2 * DAY, 3_600_000, [0; 16]);
    assert_eq!(s.pending_unlocks.len(), 1);
    assert_eq!(s.windows[0].ends, NOW + 2 * DAY);
    // after a full day of monotonic time the wait is over even with the wall clock still back
    handle(&mut s, &mut c, Request::GetStatus, NOW - 2 * DAY, DAY + 1000, [0; 16]);
    assert!(s.pending_unlocks.is_empty());
    assert!(s.windows[0].ends <= NOW + DAY + 1000);
}

#[test]
fn reset_clock_clears_pending() {
    let (mut s, mut c) = locked_with_pending();
    run(&mut s, &mut c, Request::RequestDelayedUnlock { window_id: "a".into() });
    s.windows[0].ends = NOW - 1; // window over, so a reset is allowed
    assert_eq!(run(&mut s, &mut c, Request::ResetClock), Response::Ok);
    assert!(s.pending_unlocks.is_empty());
}

#[test]
fn push_with_bad_delay_reports_bad_window_through_handle_line() {
    let (mut s, mut c) = with_partner();
    let w = json!({"id":"a","starts":NOW-1000,"ends":NOW+3_600_000,"lock":"locked","mode":"block","sites":["x.com"],"apps":[],"unlock_delay_ms":1000});
    let out = handle_line(&mut s, &mut c, &json!({"type":"PushWindows","windows":[w]}).to_string(), NOW, 0, [0; 16]);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v, json!({"type":"Error","code":"bad-window","message":"bad-delay"}));
}
