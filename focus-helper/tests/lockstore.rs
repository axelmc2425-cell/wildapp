use focus_helper::lockstore::*;
use focus_helper::model::{Lock, Mode, Window};
use focus_helper::unlock::{b64u_decode, b64u_encode, Challenge, UnlockError};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::Value;

const NOW: i64 = 1_700_000_000_000;
const H: i64 = 3_600_000;

fn win(id: &str, lock: Lock, starts: i64, ends: i64) -> Window {
    Window {
        id: id.into(),
        starts,
        ends,
        lock,
        mode: Mode::Block,
        sites: vec!["example.com".into()],
        apps: vec!["game.exe".into()],
    }
}

fn keys() -> (SigningKey, String) {
    let sk = SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
    let pk = b64u_encode(sk.verifying_key().to_encoded_point(false).as_bytes());
    (sk, pk)
}

fn token(sk: &SigningKey, nonce: &str, window: &str, exp: i64) -> String {
    let payload = format!(r#"{{"n":"{nonce}","w":"{window}","exp":{exp}}}"#);
    let sig: Signature = sk.sign(payload.as_bytes());
    format!("{}.{}", b64u_encode(payload.as_bytes()), b64u_encode(&sig.to_bytes()))
}

fn with_partner() -> (LockStore, SigningKey) {
    let (sk, pk) = keys();
    let mut s = LockStore::default();
    s.set_partner(&pk, NOW).unwrap();
    (s, sk)
}

fn nonce_of(code: &str) -> String {
    let v: Value = serde_json::from_slice(&b64u_decode(code).unwrap()).unwrap();
    v["n"].as_str().unwrap().to_string()
}

#[test]
fn locked_push_without_partner_rejected() {
    let mut s = LockStore::default();
    assert_eq!(s.push(vec![win("a", Lock::Locked, NOW - H, NOW + H)], NOW), Err(PushError::NoPartner));
    assert_eq!(s.push(vec![win("a", Lock::Frozen, NOW - H, NOW + H)], NOW), Err(PushError::NoPartner));
    assert!(s.windows.is_empty());
    assert!(s.push(vec![win("n", Lock::None, NOW - H, NOW + H)], NOW).is_ok());
}

#[test]
fn invalid_windows_rejected_with_js_reasons() {
    let (mut s, _) = with_partner();
    let mut e = |w| s.push(vec![w], NOW);
    assert_eq!(e(win("a", Lock::None, 10, 10)), Err(PushError::Invalid(Invalid::BadTimes)));
    assert_eq!(e(win("a", Lock::None, 10, 5)), Err(PushError::Invalid(Invalid::BadTimes)));
    assert_eq!(e(win("a", Lock::Locked, NOW, NOW + MAX_LOCKED_MS + 1)), Err(PushError::Invalid(Invalid::TooLong)));
    assert_eq!(e(win("a", Lock::Frozen, NOW, NOW + MAX_FROZEN_MS + 1)), Err(PushError::Invalid(Invalid::TooLong)));
    assert!(e(win("a", Lock::Frozen, NOW, NOW + MAX_FROZEN_MS)).is_ok());
    assert_eq!(Invalid::TooLong.reason(), "too-long");
}

#[test]
fn bad_items_rejected() {
    let mut s = LockStore::default();
    let bad_sites = ["", "a b.com", "a\tb", "a\nb.com", "evil.com\n127.0.0.1 bank.com", "a#b.com", "a/b.com", "a\\b.com", "a\u{0}b", "a\u{a0}b"];
    for b in bad_sites {
        let mut w = win("n", Lock::None, NOW - H, NOW + H);
        w.sites = vec![b.into()];
        assert_eq!(s.push(vec![w], NOW), Err(PushError::BadItem), "site {b:?}");
    }
    for b in ["", "my app.exe", "a\u{7}b", "a\r"] {
        let mut w = win("n", Lock::None, NOW - H, NOW + H);
        w.apps = vec![b.into()];
        assert_eq!(s.push(vec![w], NOW), Err(PushError::BadItem), "app {b:?}");
    }
    assert!(s.windows.is_empty());
}

#[test]
fn rejected_push_changes_nothing() {
    let mut s = LockStore::default();
    s.push(vec![win("keep", Lock::None, NOW - H, NOW + H)], NOW).unwrap();
    let mut bad = win("x", Lock::None, NOW - H, NOW + H);
    bad.sites = vec!["a/b".into()];
    assert!(s.push(vec![win("y", Lock::None, NOW - H, NOW + H), bad], NOW).is_err());
    assert_eq!(s.windows.len(), 1);
    assert_eq!(s.windows[0].id, "keep");
}

#[test]
fn empty_push_leaves_active_locked_window() {
    let (mut s, _) = with_partner();
    s.push(vec![win("l", Lock::Locked, NOW - H, NOW + H)], NOW).unwrap();
    let r = s.push(vec![], NOW + 1000).unwrap();
    assert_eq!(r.kept, 1);
    assert_eq!(s.windows.len(), 1);
    // a locked window not yet started is retained too
    s.push(vec![win("f", Lock::Locked, NOW + 2 * H, NOW + 3 * H)], NOW).unwrap();
    s.push(vec![], NOW).unwrap();
    assert_eq!(s.windows.len(), 2);
}

#[test]
fn same_id_extends_but_never_shortens_or_edits() {
    let (mut s, _) = with_partner();
    s.push(vec![win("l", Lock::Locked, NOW - H, NOW + H)], NOW).unwrap();
    let r = s.push(vec![win("l", Lock::Locked, NOW - H, NOW + 2 * H)], NOW).unwrap();
    assert_eq!(r.extended, 1);
    assert_eq!(s.windows[0].ends, NOW + 2 * H);
    s.push(vec![win("l", Lock::Locked, NOW - H, NOW + H)], NOW).unwrap();
    assert_eq!(s.windows[0].ends, NOW + 2 * H);
    // other fields ignored: try to downgrade to none, change sites, move start
    let mut w = win("l", Lock::None, NOW - 5 * H, NOW + 9 * H);
    w.sites = vec!["other.com".into()];
    w.mode = Mode::Allow;
    s.push(vec![w], NOW).unwrap();
    assert_eq!(s.windows.len(), 1);
    assert_eq!(s.windows[0].lock, Lock::Locked);
    assert_eq!(s.windows[0].starts, NOW - H);
    assert_eq!(s.windows[0].sites, vec!["example.com".to_string()]);
    assert_eq!(s.windows[0].mode, Mode::Block);
    assert_eq!(s.windows[0].ends, NOW + 2 * H); // a downgrade attempt does not even extend
}

#[test]
fn extension_cap_measured_from_stored_start() {
    let (mut s, _) = with_partner();
    s.push(vec![win("f", Lock::Frozen, NOW, NOW + H)], NOW).unwrap();
    // incoming moves start later so it passes validation alone, but the stored start governs
    let r = s.push(vec![win("f", Lock::Frozen, NOW + 5 * H, NOW + 5 * H + MAX_FROZEN_MS)], NOW);
    assert_eq!(r, Err(PushError::Invalid(Invalid::TooLong)));
    assert_eq!(s.windows[0].ends, NOW + H);
}

#[test]
fn none_windows_replaced_and_removed() {
    let mut s = LockStore::default();
    s.push(vec![win("a", Lock::None, NOW - H, NOW + H)], NOW).unwrap();
    let r = s.push(vec![win("b", Lock::None, NOW - H, NOW + H)], NOW).unwrap();
    assert_eq!((r.added, r.replaced), (1, 1));
    assert_eq!(s.windows.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["b"]);
    s.push(vec![], NOW).unwrap();
    assert!(s.windows.is_empty());
}

#[test]
fn finished_windows_dropped() {
    let (mut s, _) = with_partner();
    s.push(vec![win("a", Lock::None, NOW - 2 * H, NOW - H), win("l", Lock::Locked, NOW - 2 * H, NOW)], NOW).unwrap();
    assert!(s.windows.is_empty());
    s.windows.push(win("old", Lock::Locked, NOW - 2 * H, NOW - H));
    s.push(vec![], NOW).unwrap();
    assert!(s.windows.is_empty());
}

#[test]
fn overlapping_none_and_locked_removing_none_leaves_lock() {
    let (mut s, _) = with_partner();
    s.push(vec![win("n", Lock::None, NOW - H, NOW + H), win("l", Lock::Locked, NOW - H, NOW + H)], NOW).unwrap();
    assert_eq!(s.windows.len(), 2);
    s.push(vec![win("l", Lock::Locked, NOW - H, NOW + H)], NOW).unwrap();
    assert_eq!(s.windows.len(), 1);
    assert_eq!(s.windows[0].id, "l");
    s.push(vec![], NOW).unwrap();
    assert_eq!(s.windows[0].id, "l");
}

#[test]
fn set_partner_rules() {
    let (sk, pk) = keys();
    let mut s = LockStore::default();
    assert_eq!(s.set_partner("garbage", NOW), Err(PartnerError::BadKey));
    assert_eq!(s.set_partner(&b64u_encode(&[0u8; 65]), NOW), Err(PartnerError::BadKey));
    let compressed = b64u_encode(sk.verifying_key().to_encoded_point(true).as_bytes());
    assert_eq!(s.set_partner(&compressed, NOW), Err(PartnerError::BadKey));
    assert_eq!(s.set_partner(&format!("{pk}="), NOW), Err(PartnerError::BadKey));
    assert_eq!(s.partner_key, None);
    s.set_partner(&pk, NOW).unwrap();
    s.push(vec![win("l", Lock::Locked, NOW - H, NOW + H)], NOW).unwrap();
    let (_, pk2) = {
        let sk2 = SigningKey::from_bytes(&[5u8; 32].into()).unwrap();
        let p = b64u_encode(sk2.verifying_key().to_encoded_point(false).as_bytes());
        (sk2, p)
    };
    assert_eq!(s.set_partner(&pk2, NOW), Err(PartnerError::LockActive));
    assert_eq!(s.partner_key.as_deref(), Some(pk.as_str()));
    // allowed once the lock is over
    s.set_partner(&pk2, NOW + 2 * H).unwrap();
    assert_eq!(s.partner_key.as_deref(), Some(pk2.as_str()));
}

#[test]
fn challenge_only_for_active_lock() {
    let (mut s, _) = with_partner();
    s.push(
        vec![
            win("n", Lock::None, NOW - H, NOW + H),
            win("future", Lock::Locked, NOW + H, NOW + 2 * H),
            win("l", Lock::Locked, NOW - H, NOW + H),
        ],
        NOW,
    )
    .unwrap();
    assert_eq!(s.request_challenge("n", NOW, [0; 16]), Err(ChallengeError::NoSuchLock));
    assert_eq!(s.request_challenge("future", NOW, [0; 16]), Err(ChallengeError::NoSuchLock));
    assert_eq!(s.request_challenge("missing", NOW, [0; 16]), Err(ChallengeError::NoSuchLock));
    let code = s.request_challenge("l", NOW, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]).unwrap();
    let v: Value = serde_json::from_slice(&b64u_decode(&code).unwrap()).unwrap();
    assert_eq!(v, serde_json::json!({"n": "AAECAwQFBgcICQoLDA0ODw", "w": "l"}));
    assert_eq!(s.challenges.len(), 1);
    // stale challenges dropped on add
    s.request_challenge("l", NOW + 2 * H - 1, [1; 16]).ok();
    s.request_challenge("l", NOW + 59 * 60_000, [2; 16]).unwrap();
    assert!(s.challenges.iter().all(|c| NOW + 59 * 60_000 - c.issued <= 3_600_000));
}

fn setup_two_locks() -> (LockStore, SigningKey, String, String) {
    let (mut s, sk) = with_partner();
    s.push(vec![win("a", Lock::Locked, NOW - H, NOW + H), win("b", Lock::Frozen, NOW - H, NOW + H)], NOW).unwrap();
    let ca = nonce_of(&s.request_challenge("a", NOW, [1; 16]).unwrap());
    let cb = nonce_of(&s.request_challenge("b", NOW, [2; 16]).unwrap());
    (s, sk, ca, cb)
}

#[test]
fn valid_token_ends_only_its_window() {
    let (mut s, sk, na, _) = setup_two_locks();
    let t = token(&sk, &na, "a", NOW + 600_000);
    assert_eq!(s.submit_token(&t, NOW + 1000), Ok("a".to_string()));
    let a = s.windows.iter().find(|w| w.id == "a").unwrap();
    let b = s.windows.iter().find(|w| w.id == "b").unwrap();
    assert_eq!(a.ends, NOW + 1000);
    assert_eq!(b.ends, NOW + H);
    // a is no longer active, so the partner key may now not change (b still active)
    assert_eq!(s.set_partner(&keys().1, NOW + 2000), Err(PartnerError::LockActive));
}

#[test]
fn same_token_twice_is_used() {
    let (mut s, sk, na, _) = setup_two_locks();
    let t = token(&sk, &na, "a", NOW + 600_000);
    assert!(s.submit_token(&t, NOW + 1000).is_ok());
    assert_eq!(s.submit_token(&t, NOW + 2000), Err(UnlockError::Used));
    assert_eq!(s.windows.iter().find(|w| w.id == "a").unwrap().ends, NOW + 1000);
}

#[test]
fn bad_tokens_do_not_mutate() {
    let (mut s, sk, na, nb) = setup_two_locks();
    let before = s.clone();
    let other = SigningKey::from_bytes(&[3u8; 32].into()).unwrap();
    let cases: Vec<(String, UnlockError)> = vec![
        ("garbage".into(), UnlockError::BadFormat),
        (token(&other, &na, "a", NOW + 600_000), UnlockError::BadSignature),
        (token(&other, "unknown-nonce", "a", NOW + 600_000), UnlockError::BadSignature),
        (token(&sk, "unknown-nonce", "a", NOW + 600_000), UnlockError::WrongChallenge),
        (token(&sk, &na, "b", NOW + 600_000), UnlockError::WrongLock),
        (token(&sk, &nb, "a", NOW + 600_000), UnlockError::WrongLock),
        (token(&sk, &na, "a", NOW + 500), UnlockError::Expired),
    ];
    for (t, e) in cases {
        assert_eq!(s.submit_token(&t, NOW + 1000), Err(e), "{t}");
        assert_eq!(s, before);
    }
    // challenge older than an hour
    assert_eq!(
        s.submit_token(&token(&sk, &na, "a", NOW + 10 * H), NOW + H + 1),
        Err(UnlockError::ChallengeExpired)
    );
    assert_eq!(s, before);
}

#[test]
fn token_without_partner_key_is_rejected() {
    let (_, sk, ..) = setup_two_locks();
    let mut s = LockStore::default();
    s.windows.push(win("a", Lock::Locked, NOW - H, NOW + H));
    s.challenges.push(Challenge { nonce: "x".into(), window_id: "a".into(), issued: NOW, used: false });
    assert_eq!(s.submit_token(&token(&sk, "x", "a", NOW + 600_000), NOW), Err(UnlockError::BadSignature));
    assert_eq!(s.windows[0].ends, NOW + H);
}

#[test]
fn token_for_vanished_window_is_wrong_lock_and_not_consumed() {
    let (mut s, sk, na, _) = setup_two_locks();
    s.windows.retain(|w| w.id != "a");
    assert_eq!(s.submit_token(&token(&sk, &na, "a", NOW + 600_000), NOW), Err(UnlockError::WrongLock));
    assert!(!s.challenges.iter().find(|c| c.nonce == na).unwrap().used);
}

#[test]
fn fixture_valid_vector_through_store() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/unlock-vectors.json")).unwrap();
    let vs: Vec<Value> = serde_json::from_str(&raw).unwrap();
    let v = vs.iter().find(|v| v["name"] == "valid").unwrap();
    let now = v["now"].as_i64().unwrap();
    let mut s = LockStore::default();
    s.partner_key = Some(v["publicKey"].as_str().unwrap().into());
    s.windows.push(win(v["challenge"]["windowId"].as_str().unwrap(), Lock::Locked, now - H, now + H));
    s.challenges.push(serde_json::from_value(v["challenge"].clone()).unwrap());
    let t = v["token"].as_str().unwrap();
    assert_eq!(s.submit_token(t, now), Ok("win-1".to_string()));
    assert_eq!(s.windows[0].ends, now);
    assert_eq!(s.submit_token(t, now), Err(UnlockError::Used));
}

#[test]
fn store_roundtrips_through_serde() {
    let (mut s, _) = with_partner();
    s.push(vec![win("l", Lock::Locked, NOW - H, NOW + H)], NOW).unwrap();
    s.request_challenge("l", NOW, [4; 16]).unwrap();
    let back: LockStore = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
    assert_eq!(back, s);
}
