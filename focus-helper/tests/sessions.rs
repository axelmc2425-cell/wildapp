use focus_helper::sessions::*;
use std::fs;

const D: &str = "2026-11-13";

fn tmp(name: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("sessions-test-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}

fn st(s: i64, e: i64, exe: &str, site: Option<&str>) -> Stretch {
    Stretch { start: s, end: e, exe: exe.into(), site: site.map(String::from) }
}

#[test]
fn merges_same_program_and_site_within_gap() {
    let mut s = SessionStore::new();
    s.record(D, "a.exe", Some("x.com"), 100, 101, 1);
    s.record(D, "a.exe", Some("x.com"), 101, 102, 1);
    s.record(D, "a.exe", Some("x.com"), 103, 104, 1);
    assert_eq!(s.day(D).unwrap().stretches, vec![st(100, 104, "a.exe", Some("x.com"))]);
}

#[test]
fn different_site_makes_new_stretch() {
    let mut s = SessionStore::new();
    s.record(D, "a.exe", Some("x.com"), 100, 101, 1);
    s.record(D, "a.exe", Some("y.com"), 101, 102, 1);
    s.record(D, "b.exe", Some("y.com"), 102, 103, 1);
    assert_eq!(s.day(D).unwrap().stretches.len(), 3);
}

#[test]
fn gap_over_two_seconds_splits() {
    let mut s = SessionStore::new();
    s.record(D, "a.exe", None, 100, 101, 1);
    s.record(D, "a.exe", None, 103, 104, 1); // gap 2: merges
    s.record(D, "a.exe", None, 107, 108, 1); // gap 3: splits
    assert_eq!(
        s.day(D).unwrap().stretches,
        vec![st(100, 104, "a.exe", None), st(107, 108, "a.exe", None)]
    );
}

#[test]
fn gap_tolerates_five_second_reports() {
    let mut s = SessionStore::new();
    s.record(D, "a.exe", None, 100, 105, 5);
    s.record(D, "a.exe", None, 114, 119, 5); // gap 9 merges
    assert_eq!(s.day(D).unwrap().stretches, vec![st(100, 119, "a.exe", None)]);
    s.record(D, "a.exe", None, 130, 135, 5); // gap 11 splits
    assert_eq!(s.day(D).unwrap().stretches.len(), 2);
}

#[test]
fn gap_exactly_at_tolerance_merges() {
    let mut s = SessionStore::new();
    s.record(D, "a.exe", None, 100, 105, 5);
    s.record(D, "a.exe", None, 115, 120, 5); // gap 10 merges
    assert_eq!(s.day(D).unwrap().stretches, vec![st(100, 120, "a.exe", None)]);
}

#[test]
fn partial_overlap_is_clamped() {
    let mut s = SessionStore::new();
    s.record(D, "a.exe", None, 100, 110, 1);
    s.record(D, "b.exe", None, 105, 115, 1);
    assert_eq!(
        s.day(D).unwrap().stretches,
        vec![st(100, 110, "a.exe", None), st(110, 115, "b.exe", None)]
    );
    let mut s = SessionStore::new();
    s.record(D, "a.exe", None, 100, 110, 1);
    s.record(D, "a.exe", None, 105, 115, 1);
    assert_eq!(s.day(D).unwrap().stretches, vec![st(100, 115, "a.exe", None)]);
}

#[test]
fn hostile_days_are_rejected() {
    let base = tmp("hostile");
    let dir = base.join("inner");
    fs::create_dir_all(&dir).unwrap();
    fs::write(base.join("sessions-x.json"), b"outside").unwrap();
    let d = DayStretches { truncated: false, stretches: vec![st(1, 2, "a", None)] };
    let mut s = SessionStore::new();
    for bad in ["../x", "a/b", "", "2026-11-13/../..", "..\\x"] {
        assert!(session_file(&dir, bad).is_none());
        assert_eq!(save_day(&dir, bad, &d).unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
        assert_eq!(load_day(&dir, bad, 1).day, None);
        s.record(bad, "a", None, 1, 2, 1);
        s.set_day(bad, d.clone());
        assert!(s.day(bad).is_none());
    }
    assert!(s.dirty_days().is_empty());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    assert_eq!(fs::read(base.join("sessions-x.json")).unwrap(), b"outside");
}

#[test]
fn new_day_starts_new_stretch() {
    let mut s = SessionStore::new();
    s.record("2026-11-13", "a.exe", None, 100, 101, 1);
    s.record("2026-11-14", "a.exe", None, 101, 102, 1);
    assert_eq!(s.day("2026-11-13").unwrap().stretches, vec![st(100, 101, "a.exe", None)]);
    assert_eq!(s.day("2026-11-14").unwrap().stretches, vec![st(101, 102, "a.exe", None)]);
}

#[test]
fn earlier_or_overlapping_interval_ignored() {
    let mut s = SessionStore::new();
    s.record(D, "a.exe", None, 100, 110, 1);
    s.record(D, "b.exe", None, 50, 60, 1);
    s.record(D, "a.exe", None, 105, 110, 1);
    s.record(D, "a.exe", None, 100, 109, 1);
    assert_eq!(s.day(D).unwrap().stretches, vec![st(100, 110, "a.exe", None)]);
}

#[test]
fn cap_marks_truncated_and_stops_adding() {
    let mut s = SessionStore::new();
    for i in 0..(MAX_STRETCHES_PER_DAY as i64 + 1) {
        s.record(D, "a.exe", None, i * 100, i * 100 + 1, 1);
    }
    let d = s.day(D).unwrap();
    assert_eq!(d.stretches.len(), MAX_STRETCHES_PER_DAY);
    assert!(d.truncated);
    s.record(D, "a.exe", None, 10_000_000, 10_000_001, 1);
    assert_eq!(s.day(D).unwrap().stretches.len(), MAX_STRETCHES_PER_DAY);
}

#[test]
fn prune_keeps_newest_90_days() {
    let mut s = SessionStore::new();
    for i in 1..=100 {
        let day = format!("2026-{:02}-{:02}", 1 + (i - 1) / 28, 1 + (i - 1) % 28);
        s.set_day(&day, DayStretches { truncated: false, stretches: vec![st(1, 2, "a", None)] });
    }
    s.prune();
    assert!(s.day("2026-01-01").is_none());
    assert!(s.day("2026-01-10").is_none());
    assert!(s.day("2026-01-11").is_some());
    assert!(s.day("2026-04-16").is_some());
}

#[test]
fn save_load_roundtrip() {
    let dir = tmp("rt");
    let d = DayStretches { truncated: true, stretches: vec![st(1, 5, "a", Some("x.com"))] };
    save_day(&dir, D, &d).unwrap();
    assert_eq!(session_file(&dir, D).unwrap(), dir.join("sessions-2026-11-13.json"));
    let l = load_day(&dir, D, 1);
    assert_eq!((l.day, l.from_backup, l.quarantined), (Some(d), false, None));
}

#[test]
fn load_falls_back_to_bak() {
    let dir = tmp("bak");
    let d1 = DayStretches { truncated: false, stretches: vec![st(1, 5, "a", None)] };
    let d2 = DayStretches { truncated: false, stretches: vec![st(1, 9, "a", None)] };
    save_day(&dir, D, &d1).unwrap();
    save_day(&dir, D, &d2).unwrap();
    fs::write(session_file(&dir, D).unwrap(), b"garbage").unwrap();
    let l = load_day(&dir, D, 7);
    assert_eq!((l.day, l.from_backup), (Some(d1), true));
    assert_eq!(l.quarantined, Some(dir.join("sessions-2026-11-13.json.corrupt-7")));
    assert!(dir.join("sessions-2026-11-13.json.corrupt-7").exists());
}

#[test]
fn corrupt_file_is_quarantined_and_returns_none() {
    let dir = tmp("corrupt");
    fs::write(session_file(&dir, D).unwrap(), b"garbage").unwrap();
    let l = load_day(&dir, D, 42);
    assert_eq!(l.day, None);
    assert_eq!(l.quarantined, Some(dir.join("sessions-2026-11-13.json.corrupt-42")));
    assert!(!session_file(&dir, D).unwrap().exists());
    assert!(dir.join("sessions-2026-11-13.json.corrupt-42").exists());
}

#[test]
fn no_file_returns_none() {
    let dir = tmp("none");
    assert_eq!(load_day(&dir, D, 1).day, None);
}

#[test]
fn record_dirties_only_that_day() {
    let mut s = SessionStore::new();
    s.record("2026-11-13", "a", None, 1, 2, 1);
    s.record("2026-11-14", "a", None, 1, 2, 1);
    s.mark_clean();
    assert!(s.dirty_days().is_empty());
    s.record("2026-11-14", "a", None, 2, 3, 1);
    assert_eq!(s.dirty_days(), vec!["2026-11-14".to_string()]);
}

#[test]
fn delete_old_files_removes_unlisted_days() {
    let dir = tmp("del");
    let d = DayStretches { truncated: false, stretches: vec![] };
    save_day(&dir, "2026-11-12", &d).unwrap();
    save_day(&dir, "2026-11-13", &d).unwrap();
    fs::write(dir.join("other.json"), b"x").unwrap();
    delete_old_files(&dir, &["2026-11-13".to_string()]);
    assert!(!session_file(&dir, "2026-11-12").unwrap().exists());
    assert!(session_file(&dir, "2026-11-13").unwrap().exists());
    assert!(dir.join("other.json").exists());
}

#[test]
fn read_error_is_not_quarantined() {
    let dir = tmp("readerr");
    // A directory where the file should be: reading fails, but the bytes were never judged corrupt.
    fs::create_dir(session_file(&dir, D).unwrap()).unwrap();
    let l = load_day(&dir, D, 5);
    assert_eq!((l.day, l.quarantined), (None, None));
    assert!(session_file(&dir, D).unwrap().exists());
    assert!(!dir.join("sessions-2026-11-13.json.corrupt-5").exists());
}
