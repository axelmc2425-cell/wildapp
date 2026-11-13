use focus_helper::usage::*;

fn s(exe: &str, title: Option<&str>, idle: u64, day: &str) -> Sample {
    Sample { exe: exe.into(), title: title.map(|t| t.into()), idle_secs: idle, day: day.into(), hour: None }
}

fn sh(exe: &str, day: &str, hour: u8) -> Sample {
    Sample { hour: Some(hour), ..s(exe, None, 0, day) }
}

fn day(d: &str, total: u64) -> DayUsage {
    DayUsage { day: d.into(), total, ..Default::default() }
}

fn tmpdir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("focus-usage-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn cap_is_15_seconds() {
    let mut u = UsageStore::new();
    u.record(Some(&s("chrome.exe", None, 0, "2026-01-01")), 60, &[]);
    let r = u.range("2026-01-01", "2026-01-01").unwrap();
    assert_eq!(r[0].total, 15);
    assert_eq!(r[0].apps["chrome.exe"], 15);
}

#[test]
fn idle_not_counted() {
    let mut u = UsageStore::new();
    u.record(Some(&s("a.exe", None, 301, "2026-01-01")), 5, &[]);
    assert!(u.range("2026-01-01", "2026-01-01").unwrap().is_empty());
    u.record(Some(&s("a.exe", None, 300, "2026-01-01")), 5, &[]);
    assert_eq!(u.range("2026-01-01", "2026-01-01").unwrap()[0].total, 5);
}

#[test]
fn none_sample_adds_nothing() {
    let mut u = UsageStore::new();
    u.record(None, 5, &[]);
    u.record(Some(&s("a.exe", None, 0, "2026-01-01")), 0, &[]);
    assert!(u.range("2026-01-01", "2026-12-31").unwrap().is_empty());
    assert!(!u.dirty());
}

#[test]
fn program_name_lowercased() {
    let mut u = UsageStore::new();
    u.record(Some(&s("Code.EXE", None, 0, "2026-01-01")), 5, &[]);
    let r = u.range("2026-01-01", "2026-01-01").unwrap();
    assert_eq!(r[0].apps.get("code.exe"), Some(&5));
    assert_eq!(r[0].apps.len(), 1);
}

#[test]
fn browser_site_and_other() {
    let mut u = UsageStore::new();
    u.record(Some(&s("chrome.exe", Some("x - YouTube"), 0, "2026-01-01")), 5, &[]);
    u.record(Some(&s("chrome.exe", Some("Untitled"), 0, "2026-01-01")), 4, &[]);
    u.record(Some(&s("chrome.exe", None, 0, "2026-01-01")), 3, &[]);
    u.record(Some(&s("notepad.exe", Some("YouTube"), 0, "2026-01-01")), 5, &[]);
    let d = &u.range("2026-01-01", "2026-01-01").unwrap()[0];
    assert_eq!(d.sites.get("YouTube"), Some(&5));
    assert_eq!(d.sites.len(), 1);
    assert_eq!(d.other_browsing, 7);
    assert_eq!(d.apps["notepad.exe"], 5);
    assert_eq!(d.total, 17);
}

#[test]
fn own_stem_used() {
    let mut u = UsageStore::new();
    u.record(Some(&s("firefox.exe", Some("Inbox | acmecorp"), 0, "2026-01-01")), 5, &["acmecorp".to_string()]);
    assert_eq!(u.range("2026-01-01", "2026-01-01").unwrap()[0].sites.get("acmecorp"), Some(&5));
}

#[test]
fn titles_never_stored() {
    let mut u = UsageStore::new();
    u.record(Some(&s("chrome.exe", Some("SECRET-TITLE - YouTube"), 0, "2026-01-01")), 5, &[]);
    u.record(Some(&s("chrome.exe", Some("SECRET-TITLE"), 0, "2026-01-01")), 5, &[]);
    let json = serde_json::to_string(&u.range("2026-01-01", "2026-01-01").unwrap()).unwrap();
    assert!(!json.contains("SECRET-TITLE"));
    let dir = tmpdir("secret");
    let p = dir.join("usage.json");
    save(&p, &u).unwrap();
    assert!(!std::fs::read_to_string(&p).unwrap().contains("SECRET-TITLE"));
}

#[test]
fn day_rollover() {
    let mut u = UsageStore::new();
    u.record(Some(&s("a.exe", None, 0, "2026-01-01")), 5, &[]);
    u.record(Some(&s("a.exe", None, 0, "2026-01-02")), 5, &[]);
    let r = u.range("2026-01-01", "2026-01-02").unwrap();
    assert_eq!(r.len(), 2);
    assert_eq!(r[0].day, "2026-01-01");
    assert_eq!(r[1].day, "2026-01-02");
}

#[test]
fn rollup_at_200() {
    let mut u = UsageStore::new();
    for i in 0..205 {
        u.record(Some(&s(&format!("app{i}.exe"), None, 0, "2026-01-01")), 1, &[]);
    }
    let d = &u.range("2026-01-01", "2026-01-01").unwrap()[0];
    assert_eq!(d.apps.len(), 201);
    assert_eq!(d.apps["other"], 5);
    // an already-known name still accumulates on itself
    u.record(Some(&s("app0.exe", None, 0, "2026-01-01")), 1, &[]);
    assert_eq!(u.range("2026-01-01", "2026-01-01").unwrap()[0].apps["app0.exe"], 2);

    let mut u = UsageStore::new();
    let stems: Vec<String> = (0..205).map(|i| format!("site{i}")).collect();
    for st in &stems {
        u.record(Some(&s("chrome.exe", Some(&format!("Home | {st}")), 0, "2026-01-01")), 1, &stems);
    }
    let d = &u.range("2026-01-01", "2026-01-01").unwrap()[0];
    assert_eq!(d.sites.len(), 201);
    assert_eq!(d.sites["other"], 5);
}

#[test]
fn range_bounds() {
    let mut u = UsageStore::new();
    for d in ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-05"] {
        u.add_day(day(d, 1));
    }
    let r = u.range("2026-03-02", "2026-03-05").unwrap();
    let days: Vec<_> = r.iter().map(|d| d.day.as_str()).collect();
    assert_eq!(days, ["2026-03-02", "2026-03-03", "2026-03-05"]);
    assert_eq!(u.range("2026-03-02", "2026-03-02").unwrap().len(), 1);
    assert_eq!(u.range("2026-03-05", "2026-03-02"), Err(RangeError::Reversed));
    assert_eq!(u.range("2026-13-40", "2026-13-41"), Err(RangeError::BadDay));
    assert_eq!(u.range("2026-02-29", "2026-03-01"), Err(RangeError::BadDay));
    assert_eq!(u.range("2026-3-1", "2026-03-02"), Err(RangeError::BadDay));
    assert_eq!(u.range("2026-03-01", "garbage"), Err(RangeError::BadDay));
    assert!(u.range("2024-02-29", "2024-03-01").is_ok());
    // 400 days inclusive from 2026-01-01 ends 2027-02-04
    assert!(u.range("2026-01-01", "2027-02-04").is_ok());
    assert_eq!(u.range("2026-01-01", "2027-02-05"), Err(RangeError::TooLong));
}

#[test]
fn prune_730() {
    let mut u = UsageStore::new();
    // 800 consecutive days starting 2022-01-01
    let mut n = 0u32;
    for y in 2022..=2025 {
        for m in 1..=12u32 {
            for d in 1..=28u32 {
                if n < 800 {
                    u.add_day(day(&format!("{y}-{m:02}-{d:02}"), 1));
                    n += 1;
                }
            }
        }
    }
    u.prune();
    let kept = u.range("2022-01-01", "2023-01-31").unwrap().len()
        + u.range("2023-02-01", "2024-02-29").unwrap().len()
        + u.range("2024-03-01", "2024-12-31").unwrap().len();
    assert_eq!(kept, 730);
    // the 71st seeded day is the oldest kept, the 800th the newest
    assert!(u.range("2022-01-01", "2022-03-14").unwrap().is_empty());
    assert_eq!(u.range("2022-03-15", "2022-03-15").unwrap().len(), 1);
    assert_eq!(u.range("2024-05-16", "2024-05-16").unwrap().len(), 1);
}

#[test]
fn persistence_round_trip() {
    let dir = tmpdir("rt");
    let p = dir.join("usage.json");
    let mut u = UsageStore::new();
    u.record(Some(&s("chrome.exe", Some("a - YouTube"), 0, "2026-01-01")), 5, &[]);
    u.record(Some(&s("code.exe", None, 0, "2026-01-02")), 7, &[]);
    save(&p, &u).unwrap();
    let (l, how) = load(&p, 1);
    assert_eq!(how, UsageLoad::Main);
    assert_eq!(l, u);
    assert!(!l.dirty());
    assert!(!p.with_file_name("usage.json.bak").exists());
    save(&p, &u).unwrap();
    assert!(p.with_file_name("usage.json.bak").exists());
    let text = std::fs::read_to_string(&p).unwrap();
    assert!(text.contains("\"version\":1"));
}

#[test]
fn fresh_and_backup_loads() {
    let dir = tmpdir("fresh");
    let p = dir.join("usage.json");
    let (u, how) = load(&p, 1);
    assert_eq!(how, UsageLoad::Fresh);
    assert!(u.range("2026-01-01", "2026-12-31").unwrap().is_empty());
    let mut st = UsageStore::new();
    st.add_day(day("2026-01-01", 9));
    save(&p, &st).unwrap();
    save(&p, &st).unwrap();
    std::fs::remove_file(&p).unwrap();
    let (l, how) = load(&p, 1);
    assert_eq!(how, UsageLoad::Backup(None));
    assert_eq!(l, st);
}

#[test]
fn corrupt_file_recovery() {
    let dir = tmpdir("corrupt");
    let p = dir.join("usage.json");
    std::fs::write(&p, b"{garbage").unwrap();
    let (u, how) = load(&p, 1234);
    match how {
        UsageLoad::Corrupt(c) => {
            assert!(c.exists());
            assert_eq!(std::fs::read(&c).unwrap(), b"{garbage");
            assert!(c.to_string_lossy().ends_with("usage.json.corrupt-1234"));
        }
        other => panic!("{other:?}"),
    }
    assert!(!p.exists());
    assert_eq!(u, UsageStore::new());
}

#[test]
fn dirty_flag() {
    let mut u = UsageStore::new();
    assert!(!u.dirty());
    u.record(Some(&s("a.exe", None, 0, "2026-01-01")), 5, &[]);
    assert!(u.dirty());
    u.mark_clean();
    assert!(!u.dirty());
}

#[test]
fn prune_exactly_730_keeps_all() {
    let mut u = UsageStore::new();
    // 730 days: 26 months of 28 days plus 2 days
    let mut n = 0;
    'o: for y in 2022..=2025 {
        for m in 1..=12u32 {
            for d in 1..=28u32 {
                if n == 730 {
                    break 'o;
                }
                u.add_day(day(&format!("{y}-{m:02}-{d:02}"), 1));
                n += 1;
            }
        }
    }
    u.prune();
    let kept = u.range("2022-01-01", "2023-01-31").unwrap().len()
        + u.range("2023-02-01", "2024-02-29").unwrap().len()
        + u.range("2024-03-01", "2024-12-31").unwrap().len();
    assert_eq!(kept, 730);
    assert_eq!(u.range("2022-01-01", "2022-01-01").unwrap().len(), 1);
}

#[test]
fn corrupt_main_with_good_backup() {
    let dir = tmpdir("mainbad");
    let p = dir.join("usage.json");
    let mut st = UsageStore::new();
    st.add_day(day("2026-01-01", 9));
    save(&p, &st).unwrap();
    save(&p, &st).unwrap();
    std::fs::write(&p, b"nope").unwrap();
    let (l, how) = load(&p, 77);
    assert_eq!(l, st);
    let q = match how {
        UsageLoad::Backup(Some(q)) => q,
        other => panic!("{other:?}"),
    };
    assert!(q.to_string_lossy().ends_with("usage.json.corrupt-77"));
    assert_eq!(std::fs::read(&q).unwrap(), b"nope");
    assert!(!p.exists());
}

#[test]
fn corrupt_backup_only_is_corrupt() {
    let dir = tmpdir("bakbad");
    let p = dir.join("usage.json");
    std::fs::write(dir.join("usage.json.bak"), b"nope").unwrap();
    let (u, how) = load(&p, 5);
    assert_eq!(u, UsageStore::new());
    match how {
        UsageLoad::Corrupt(c) => assert!(c.to_string_lossy().ends_with("usage.json.bak.corrupt-5")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn other_version_is_quarantined() {
    let dir = tmpdir("ver");
    let p = dir.join("usage.json");
    std::fs::write(&p, br#"{"version":2,"days":[]}"#).unwrap();
    let (u, how) = load(&p, 9);
    assert_eq!(u, UsageStore::new());
    match how {
        UsageLoad::Corrupt(c) => {
            assert!(c.exists());
            assert_eq!(std::fs::read(&c).unwrap(), br#"{"version":2,"days":[]}"#);
        }
        other => panic!("{other:?}"),
    }
    assert!(!p.exists());
}

#[test]
fn failed_quarantine_is_still_corrupt_not_fresh() {
    let dir = tmpdir("noquar");
    let p = dir.join("usage.json");
    std::fs::write(&p, b"nope").unwrap();
    // A non-empty directory at the target name makes the rename fail.
    let target = dir.join("usage.json.corrupt-3");
    std::fs::create_dir_all(target.join("x")).unwrap();
    let (u, how) = load(&p, 3);
    assert_eq!(u, UsageStore::new());
    assert_eq!(how, UsageLoad::Corrupt(p.clone()));
    assert_eq!(std::fs::read(&p).unwrap(), b"nope");
}

#[test]
fn base_name_takes_last_path_component() {
    use focus_helper::usage::base_name;
    assert_eq!(base_name(r"C:\Program Files\Google\Chrome\Application\chrome.exe"), "chrome.exe");
    assert_eq!(base_name("C:/tools/code.exe"), "code.exe");
    assert_eq!(base_name("notepad.exe"), "notepad.exe");
    assert_eq!(base_name(""), "");
}

#[test]
fn day_string_zero_pads() {
    use focus_helper::usage::day_string;
    assert_eq!(day_string(2026, 3, 7), "2026-03-07");
    assert_eq!(day_string(2026, 12, 31), "2026-12-31");
}

#[test]
fn truncate_title_on_char_boundary() {
    assert_eq!(truncate_title("abc", 5), "abc");
    assert_eq!(truncate_title("abcdef", 3), "abc");
    assert_eq!(truncate_title("", 3), "");
    // 3 bytes per char: cutting at 2 chars must not split the third.
    assert_eq!(truncate_title("€€€", 2), "€€");
    assert_eq!(truncate_title("ab€cd", 3), "ab€");
    let long = "é".repeat(1500);
    let t = truncate_title(&long, 1000);
    assert_eq!(t.chars().count(), 1000);
    assert!(long.starts_with(&t));
}

#[test]
fn stored_names_are_capped_to_64_chars() {
    let mut st = UsageStore::new();
    let long_exe = format!("{}.exe", "x".repeat(100));
    st.record(Some(&s(&long_exe, None, 0, "2026-11-11")), 5, &[]);
    let d = &st.range("2026-11-11", "2026-11-11").unwrap()[0];
    let key = d.apps.keys().next().unwrap();
    assert_eq!(key.chars().count(), 64);
    assert_eq!(d.total, 5);
    let long_stem = "y".repeat(100);
    st.record(Some(&s("chrome.exe", Some(&format!("Inbox | {long_stem}")), 0, "2026-11-11")), 5, &[long_stem]);
    let d = &st.range("2026-11-11", "2026-11-11").unwrap()[0];
    assert!(d.sites.keys().all(|k| k.chars().count() <= 64), "{:?}", d.sites);
}

#[test]
fn record_with_hour_adds_to_that_hour_slot() {
    let mut u = UsageStore::new();
    u.record(Some(&sh("a.exe", "2026-01-01", 14)), 5, &[]);
    let r = u.range("2026-01-01", "2026-01-01").unwrap();
    assert_eq!(r[0].hours.len(), 24);
    assert_eq!(r[0].hours[14], 5);
    assert_eq!(r[0].total, 5);
}

#[test]
fn record_without_hour_leaves_hours_empty() {
    let mut u = UsageStore::new();
    u.record(Some(&s("a.exe", None, 0, "2026-01-01")), 5, &[]);
    let r = u.range("2026-01-01", "2026-01-01").unwrap();
    assert!(r[0].hours.is_empty());
    assert_eq!(r[0].total, 5);
}

#[test]
fn hours_sum_to_total_when_every_sample_has_hour() {
    let mut u = UsageStore::new();
    for (h, secs) in [(0u8, 3u64), (9, 7), (9, 4), (23, 15)] {
        u.record(Some(&sh("a.exe", "2026-01-01", h)), secs, &[]);
    }
    let r = u.range("2026-01-01", "2026-01-01").unwrap();
    assert_eq!(r[0].hours.iter().map(|&x| u64::from(x)).sum::<u64>(), r[0].total);
    assert_eq!(r[0].hours[9], 11);
}

#[test]
fn day_with_seconds_but_no_hours_stays_unrecorded() {
    let mut u = UsageStore::new();
    u.record(Some(&s("a.exe", None, 0, "2026-01-01")), 5, &[]);
    u.record(Some(&sh("a.exe", "2026-01-01", 3)), 5, &[]);
    let r = u.range("2026-01-01", "2026-01-01").unwrap();
    assert!(r[0].hours.is_empty());
    assert_eq!(r[0].total, 10);
}

#[test]
fn hours_roundtrip_and_old_file_without_hours_loads() {
    let dir = tmpdir("hours-rt");
    let path = dir.join("usage.json");
    let mut u = UsageStore::new();
    u.record(Some(&sh("a.exe", "2026-01-01", 14)), 5, &[]);
    u.record(Some(&s("a.exe", None, 0, "2026-01-02")), 5, &[]);
    save(&path, &u).unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"hours\""));
    let (loaded, how) = load(&path, 0);
    assert_eq!(how, UsageLoad::Main);
    assert_eq!(loaded, u);

    let old = r#"{"version":1,"days":[{"day":"2026-01-01","total":9,"apps":{"a.exe":9},"sites":{},"other_browsing":0}]}"#;
    std::fs::write(&path, old).unwrap();
    let (loaded, how) = load(&path, 0);
    assert_eq!(how, UsageLoad::Main);
    let r = loaded.range("2026-01-01", "2026-01-01").unwrap();
    assert_eq!(r[0].total, 9);
    assert!(r[0].hours.is_empty());
}
