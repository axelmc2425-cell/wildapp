use focus_helper::lockstore::LockStore;
use focus_helper::model::{Lock, Mode, Window};
use focus_helper::persist::{load, load_with_report, quarantine_corrupt, save, LoadSource};
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
            app_folders: vec![],
            unlock_delay_ms: Some(86_400_000),
        }],
        partner_key: Some("k".into()),
        challenges: vec![],
        high_water_ms: hw,
        ..LockStore::default()
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

#[test]
fn report_sources() {
    let d = dir("src");
    let p = d.join("state.json");
    assert_eq!(load_with_report(&p).1, LoadSource::Default);
    save(&p, &store("a", 1)).unwrap();
    assert_eq!(load_with_report(&p).1, LoadSource::Main);
    save(&p, &store("b", 2)).unwrap(); // a -> .bak
    fs::write(&p, b"{ not json").unwrap();
    let (s, src) = load_with_report(&p);
    assert_eq!((src, s.high_water_ms), (LoadSource::Backup, 1));
    fs::write(d.join("state.json.bak"), b"also bad").unwrap();
    let (s, src) = load_with_report(&p);
    assert_eq!((src, s.windows.len()), (LoadSource::DefaultAfterCorrupt, 0));
}

#[test]
fn quarantine_keeps_unreadable_files() {
    let d = dir("quar");
    let p = d.join("state.json");
    fs::write(&p, b"garbage").unwrap();
    let moved = quarantine_corrupt(&p, 123);
    assert_eq!(moved.len(), 1);
    assert!(!p.exists());
    assert_eq!(fs::read(d.join("state.json.corrupt-123")).unwrap(), b"garbage");
    // a good file is left alone
    save(&p, &store("a", 1)).unwrap();
    assert!(quarantine_corrupt(&p, 124).is_empty());
}

#[test]
fn old_format_state_still_loads() {
    let d = dir("old");
    let p = d.join("state.json");
    fs::write(&p, br#"{"windows":[],"partner_key":"k","challenges":[],"high_water_ms":9}"#).unwrap();
    let (s, src) = load_with_report(&p);
    assert_eq!(src, LoadSource::Main);
    assert_eq!((s.partner_key.as_deref(), s.high_water_ms, s.version), (Some("k"), 9, focus_helper::lockstore::STORE_VERSION));
}

#[test]
fn pending_survives_save_and_load() {
    use focus_helper::lockstore::PendingUnlock;
    let d = dir("pending");
    let p = d.join("state.json");
    let mut s = store("w", 5);
    s.pending_unlocks.push(PendingUnlock { window_id: "w".into(), unlock_at: 77 });
    save(&p, &s).unwrap();
    assert_eq!(load(&p).pending_unlocks, s.pending_unlocks);
    // old files without the field load with an empty list
    fs::write(&p, br#"{"windows":[],"partner_key":"k","challenges":[],"high_water_ms":9}"#).unwrap();
    assert!(load(&p).pending_unlocks.is_empty());
}

#[test]
fn uninstall_state_round_trips_and_old_files_default() {
    use focus_helper::lockstore::{UninstallPending, UninstallPermit};
    let d = dir("uninstall");
    let p = d.join("state.json");
    let mut s = store("w", 5);
    s.uninstall_wait_ms = 7_200_000;
    s.uninstall_pending = Some(UninstallPending { unlock_at: 99 });
    s.uninstall_permit = Some(UninstallPermit { granted_at: 1, expires_at: 2 });
    save(&p, &s).unwrap();
    let l = load(&p);
    assert_eq!((l.uninstall_wait_ms, l.uninstall_pending, l.uninstall_permit), (7_200_000, s.uninstall_pending, s.uninstall_permit));
    fs::write(&p, br#"{"windows":[],"partner_key":"k","challenges":[],"high_water_ms":9}"#).unwrap();
    let l = load(&p);
    assert_eq!((l.uninstall_wait_ms, l.uninstall_pending, l.uninstall_permit), (86_400_000, None, None));
}
