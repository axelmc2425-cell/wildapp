use focus_helper::limits::*;
use focus_helper::model::Lock;
use focus_helper::usage::DayUsage;
use std::collections::BTreeMap;

fn lim() -> Limit {
    Limit {
        id: "l1".into(),
        name: "Games".into(),
        apps: vec!["game.exe".into()],
        sites: vec![],
        period: Period::Daily,
        cap_secs: 3600,
        lock: Lock::None,
        unlock_delay_ms: None,
    }
}

fn day(d: &str, apps: &[(&str, u64)], sites: &[(&str, u64)], other: u64) -> DayUsage {
    let m = |v: &[(&str, u64)]| -> BTreeMap<String, u64> { v.iter().map(|(k, s)| (k.to_string(), *s)).collect() };
    DayUsage { day: d.into(), total: 0, apps: m(apps), sites: m(sites), other_browsing: other, hours: vec![] }
}

fn err(l: &Limit) -> String {
    validate_limit(l).unwrap_err()
}

#[test]
fn validation_table() {
    assert_eq!(validate_limit(&lim()), Ok(()));
    let mut l = lim();
    l.id = "".into();
    assert_eq!(err(&l), "bad-id");
    let mut l = lim();
    l.name = "  ".into();
    assert_eq!(err(&l), "bad-name");
    let mut l = lim();
    l.apps.clear();
    assert_eq!(err(&l), "no-items");
    let mut l = lim();
    l.apps = (0..101).map(|i| format!("a{i}.exe")).collect();
    assert_eq!(err(&l), "too-many-items");
    let mut l = lim();
    l.apps = (0..100).map(|i| format!("a{i}.exe")).collect();
    assert_eq!(validate_limit(&l), Ok(()));
    let mut l = lim();
    l.apps = vec!["a/b.exe".into()];
    assert_eq!(err(&l), "bad-item");
    let mut l = lim();
    l.apps.clear();
    l.sites = vec!["you tube.com".into()];
    assert_eq!(err(&l), "bad-item");
    let mut l = lim();
    l.lock = Lock::Frozen;
    assert_eq!(err(&l), "bad-lock");
}

#[test]
fn cap_boundaries() {
    let mut l = lim();
    l.cap_secs = 59;
    assert_eq!(err(&l), "bad-cap");
    l.cap_secs = 60;
    assert_eq!(validate_limit(&l), Ok(()));
    l.cap_secs = 86_400;
    assert_eq!(validate_limit(&l), Ok(()));
    l.cap_secs = 86_401;
    assert_eq!(err(&l), "bad-cap");
    l.period = Period::Weekly;
    assert_eq!(validate_limit(&l), Ok(()));
    l.cap_secs = 168 * 3600;
    assert_eq!(validate_limit(&l), Ok(()));
    l.cap_secs = 168 * 3600 + 1;
    assert_eq!(err(&l), "bad-cap");
}

#[test]
fn delay_rules() {
    let mut l = lim();
    l.lock = Lock::Locked;
    assert_eq!(err(&l), "bad-delay");
    for (d, ok) in [(3_599_999, false), (3_600_000, true), (604_800_000, true), (604_800_001, false)] {
        l.unlock_delay_ms = Some(d);
        assert_eq!(validate_limit(&l).is_ok(), ok, "{d}");
        if !ok {
            assert_eq!(err(&l), "bad-delay");
        }
    }
    let mut u = lim();
    u.unlock_delay_ms = Some(3_600_000);
    assert_eq!(err(&u), "bad-delay");
}

#[test]
fn serde_shape() {
    let mut l = lim();
    l.period = Period::Weekly;
    let j = serde_json::to_string(&l).unwrap();
    assert!(j.contains("\"period\":\"weekly\""), "{j}");
    assert!(j.contains("\"lock\":\"none\""), "{j}");
    let back: Limit = serde_json::from_str(&j).unwrap();
    assert_eq!(back, l);
}

#[test]
fn weekday() {
    assert_eq!(weekday_monday_based("2026-11-09"), Some(0));
    assert_eq!(weekday_monday_based("2026-11-14"), Some(5));
    assert_eq!(weekday_monday_based("2026-11-15"), Some(6));
    assert_eq!(weekday_monday_based("1970-01-01"), Some(3));
    assert_eq!(weekday_monday_based("2026-02-30"), None);
    assert_eq!(weekday_monday_based("nope"), None);
}

fn pd(p: Period, d: &str) -> Option<(String, String)> {
    period_days(p, d)
}
fn s(a: &str, b: &str) -> Option<(String, String)> {
    Some((a.to_string(), b.to_string()))
}

#[test]
fn period_day_ranges() {
    assert_eq!(pd(Period::Daily, "2026-11-14"), s("2026-11-14", "2026-11-14"));
    assert_eq!(pd(Period::Weekly, "2026-11-14"), s("2026-11-09", "2026-11-14"));
    assert_eq!(pd(Period::Weekly, "2026-11-09"), s("2026-11-09", "2026-11-09"));
    assert_eq!(pd(Period::Weekly, "2026-11-15"), s("2026-11-09", "2026-11-15"));
    assert_eq!(pd(Period::Weekly, "2026-12-02"), s("2026-11-30", "2026-12-02"));
    assert_eq!(pd(Period::Weekly, "2027-01-01"), s("2026-12-28", "2027-01-01"));
    assert_eq!(pd(Period::Weekly, "2024-02-29"), s("2024-02-26", "2024-02-29"));
    assert_eq!(pd(Period::Weekly, "bad"), None);
    assert_eq!(pd(Period::Daily, "2026-13-01"), None);
}

#[test]
fn period_end_days() {
    assert_eq!(period_ends_day(Period::Daily, "2026-11-14"), Some("2026-11-15".into()));
    assert_eq!(period_ends_day(Period::Weekly, "2026-11-14"), Some("2026-11-16".into()));
    assert_eq!(period_ends_day(Period::Weekly, "2026-11-09"), Some("2026-11-16".into()));
    assert_eq!(period_ends_day(Period::Weekly, "2026-11-15"), Some("2026-11-16".into()));
    assert_eq!(period_ends_day(Period::Daily, "2026-12-31"), Some("2027-01-01".into()));
    assert_eq!(period_ends_day(Period::Weekly, "2026-12-31"), Some("2027-01-04".into()));
    assert_eq!(period_ends_day(Period::Daily, "2024-02-28"), Some("2024-02-29".into()));
    assert_eq!(period_ends_day(Period::Daily, "2024-02-29"), Some("2024-03-01".into()));
    assert_eq!(period_ends_day(Period::Daily, "x"), None);
}

#[test]
fn used_apps_case_insensitive_and_period_only() {
    let mut l = lim();
    l.apps = vec!["Chrome.EXE".into()];
    // Daily: current day is the latest day in the data.
    let days = vec![day("2026-11-13", &[("chrome.exe", 500)], &[], 0), day("2026-11-14", &[("chrome.exe", 100), ("x.exe", 9)], &[], 0)];
    assert_eq!(used_secs(&l, &days, "2026-11-14"), 100);
    l.period = Period::Weekly;
    assert_eq!(used_secs(&l, &days, "2026-11-14"), 600);
    // The previous week does not count.
    let days = vec![day("2026-11-08", &[("chrome.exe", 500)], &[], 0), day("2026-11-09", &[("chrome.exe", 7)], &[], 0)];
    assert_eq!(used_secs(&l, &days, "2026-11-09"), 7);
}

#[test]
fn used_missing_and_empty() {
    let l = lim();
    assert_eq!(used_secs(&l, &[], "2026-11-14"), 0);
    let days = vec![day("2026-11-14", &[("other.exe", 5)], &[], 0)];
    assert_eq!(used_secs(&l, &days, "2026-11-14"), 0);
}

#[test]
fn used_sites() {
    let mut l = lim();
    l.apps.clear();
    l.sites = vec!["youtube.com".into()];
    let d = |label: &str| vec![day("2026-11-14", &[], &[(label, 40)], 99)];
    assert_eq!(used_secs(&l, &d("YouTube"), "2026-11-14"), 40);
    assert_eq!(used_secs(&l, &d("youtube"), "2026-11-14"), 40);
    assert_eq!(used_secs(&l, &d("Other browsing"), "2026-11-14"), 0);
    assert_eq!(used_secs(&l, &d("other"), "2026-11-14"), 0);
    assert_eq!(used_secs(&l, &d("YouTube Music"), "2026-11-14"), 0);
    assert_eq!(used_secs(&l, &d("notyoutube"), "2026-11-14"), 0);
    // Other browsing seconds are never counted.
    assert_eq!(used_secs(&l, &[day("2026-11-14", &[], &[], 500)], "2026-11-14"), 0);
    // Multi-word canonical names match the domain with spaces dropped.
    l.sites = vec!["stackoverflow.com".into()];
    assert_eq!(used_secs(&l, &d("Stack Overflow"), "2026-11-14"), 40);
    // Own-list stems: co.uk and subdomains reduce to the stem.
    l.sites = vec!["www.bbc.co.uk".into()];
    assert_eq!(used_secs(&l, &d("bbc"), "2026-11-14"), 40);
    assert_eq!(used_secs(&l, &d("BBC"), "2026-11-14"), 40);
}

#[test]
fn used_counts_each_item_once() {
    let mut l = lim();
    l.apps = vec!["game.exe".into(), "GAME.exe".into()];
    l.sites = vec!["youtube.com".into(), "www.youtube.com".into()];
    let days = vec![day("2026-11-14", &[("game.exe", 10)], &[("YouTube", 5)], 0)];
    assert_eq!(used_secs(&l, &days, "2026-11-14"), 15);
}

#[test]
fn weaker_rules() {
    let old = {
        let mut l = lim();
        l.apps = vec!["a.exe".into(), "b.exe".into()];
        l.lock = Lock::Locked;
        l.unlock_delay_ms = Some(3_600_000);
        l
    };
    let mut n = old.clone();
    assert!(!is_weaker(&old, &n));
    n.name = "renamed".into();
    assert!(!is_weaker(&old, &n));
    n = old.clone();
    n.cap_secs = 7200;
    assert!(is_weaker(&old, &n));
    n.cap_secs = 1800;
    assert!(!is_weaker(&old, &n));
    n = old.clone();
    n.apps.pop();
    assert!(is_weaker(&old, &n));
    n = old.clone();
    n.apps.push("c.exe".into());
    assert!(!is_weaker(&old, &n));
    n = old.clone();
    n.sites.push("youtube.com".into());
    n.apps.pop();
    assert!(is_weaker(&old, &n));
    n = old.clone();
    n.period = Period::Weekly;
    assert!(is_weaker(&old, &n));
    n = old.clone();
    n.lock = Lock::None;
    n.unlock_delay_ms = None;
    assert!(is_weaker(&old, &n));
    // Item removal is case-insensitive on apps: a case change is not a removal.
    n = old.clone();
    n.apps[0] = "A.EXE".into();
    assert!(!is_weaker(&old, &n));
}

#[test]
fn exceeded_boundaries() {
    let l = lim();
    let at = |s| vec![day("2026-11-14", &[("game.exe", s)], &[], 0)];
    assert!(!is_exceeded(&l, &at(3599), "2026-11-14"));
    assert!(is_exceeded(&l, &at(3600), "2026-11-14"));
    assert!(is_exceeded(&l, &at(3601), "2026-11-14"));
}

#[test]
fn current_day_selects_period() {
    let l = lim();
    let y = vec![day("2026-11-13", &[("game.exe", 500)], &[], 0)];
    assert_eq!(used_secs(&l, &y, "2026-11-14"), 0);
    assert!(!is_exceeded(&l, &y, "2026-11-14"));
    let mut w = lim();
    w.period = Period::Weekly;
    let days = vec![day("2026-11-08", &[("game.exe", 500)], &[], 0)];
    assert_eq!(used_secs(&w, &days, "2026-11-09"), 0);
    assert_eq!(used_secs(&w, &days, "2026-11-14"), 0);
    assert_eq!(used_secs(&w, &days, "2026-11-08"), 500);
    // Days after current_day are outside the period too.
    let later = vec![day("2026-11-15", &[("game.exe", 500)], &[], 0)];
    assert_eq!(used_secs(&w, &later, "2026-11-14"), 0);
    assert_eq!(used_secs(&w, &days, "nope"), 0);
    assert_eq!(used_secs(&l, &days, "2026-02-30"), 0);
}
