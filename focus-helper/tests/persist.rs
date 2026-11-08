use focus_helper::lockstore::LockStore;
use focus_helper::model::{Lock, Mode, Window};
use focus_helper::persist::{load, save};
use std::fs;
use std::path::PathBuf;

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("focus-persist-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn store(id: &str, hw: i64) -> LockStore {
    LockStore {
        windows: vec![Window {
            id: id.into(),
            starts: 1,
            ends: 2,
            lock: Lock::Locked,
            mode: Mode::Block,
            sites: vec!["a.com".into()],
            apps: vec![],
        }],
        partner_key: Some("k".into()),
        challenges: vec![],
        high_water_ms: hw,
    }
}

#[test]
fn round_trip() {
    let d = dir("rt");
    let p = d.join("state.json");
    let s = store("w", 5);
    save(&p, &s).unwrap();
    assert_eq!(load(&p), s);
}

#[test]
fn missing_files_load_default() {
    let d = dir("missing");
    assert_eq!(load(&d.join("state.json")), LockStore::default());
}

#[test]
fn truncated_main_loads_bak() {
    let d = dir("trunc");
    let p = d.join("state.json");
    let old = store("old", 1);
    save(&p, &old).unwrap();
    save(&p, &store("new", 2)).unwrap();
    let raw = fs::read(&p).unwrap();
    fs::write(&p, &raw[..raw.len() / 2]).unwrap();
    assert_eq!(load(&p), old);
    // bak is still there and good
    assert!(d.join("state.json.bak").exists());
}

#[test]
fn save_over_corrupt_main_keeps_good_bak() {
    let d = dir("keepbak");
    let p = d.join("state.json");
    let good = store("good", 1);
    save(&p, &good).unwrap();
    save(&p, &store("x", 2)).unwrap(); // bak = good
    fs::write(&p, b"{corrupt").unwrap();
    save(&p, &store("y", 3)).unwrap();
    assert_eq!(fs::read(d.join("state.json.bak")).unwrap(), serde_json::to_vec(&good).unwrap());
}

#[test]
fn both_corrupt_defaults_and_leaves_files() {
    let d = dir("both");
    let p = d.join("state.json");
    let bak = d.join("state.json.bak");
    fs::write(&p, b"{not json").unwrap();
    fs::write(&bak, b"also bad").unwrap();
    assert_eq!(load(&p), LockStore::default());
    assert_eq!(fs::read(&p).unwrap(), b"{not json");
    assert_eq!(fs::read(&bak).unwrap(), b"also bad");
}

#[test]
fn stray_tmp_after_crash_is_ignored_then_overwritten() {
    let d = dir("crash");
    let p = d.join("state.json");
    let tmp = d.join("state.json.tmp");
    let good = store("good", 7);
    save(&p, &good).unwrap();
    fs::write(&tmp, b"{\"windows\":[").unwrap(); // crash mid-write
    assert_eq!(load(&p), good);
    let next = store("next", 8);
    save(&p, &next).unwrap();
    assert_eq!(load(&p), next);
    assert!(!tmp.exists());
}
