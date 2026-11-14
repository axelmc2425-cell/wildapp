//! Daemon enforcement of time limits and the PushLimits/GetLimits protocol.
use std::io;
use std::path::PathBuf;

use focus_helper::daemon::{Daemon, Platform};
use focus_helper::enforce::{Proc, ProcessTable};
use focus_helper::usage::DayUsage;
use serde_json::{json, Value};

const NOW: i64 = 1_700_000_000_000; // 2023-11-14 (Tuesday)
const DAY0: i64 = NOW / 86_400_000;

struct Empty;
impl ProcessTable for Empty {
    fn list(&self) -> Vec<Proc> {
        Vec::new()
    }
    fn kill(&self, _: u32) -> bool {
        false
    }
}

#[derive(Default)]
struct Fake {
    hosts: Vec<Vec<String>>,
}
impl Platform for Fake {
    fn enforce_hosts(&mut self, sites: &[String]) -> io::Result<bool> {
        self.hosts.push(sites.to_vec());
        Ok(true)
    }
    fn set_doh_off(&mut self) -> io::Result<Vec<String>> {
        Ok(Vec::new())
    }
    fn clear_doh_off(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn flush_dns(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn process_table(&self) -> &dyn ProcessTable {
        &Empty
    }
}

fn paths(name: &str) -> (PathBuf, PathBuf) {
    let d = std::env::temp_dir().join(format!("focus-limits-d-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    (d.join("state.json"), d.join("usage.json"))
}

/// A day string `k` days after 2023-11-14.
fn day(k: i64) -> String {
    let (y, m, d) = civil(DAY0 + k);
    format!("{y:04}-{m:02}-{d:02}")
}
fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Wall time at noon of the day `k` days after 2023-11-14.
fn wall(k: i64) -> i64 {
    (DAY0 + k) * 86_400_000 + 43_200_000
}

struct T {
    d: Daemon,
    p: Fake,
    mono: i64,
    k: i64,
}

impl T {
    fn new(name: &str) -> (T, PathBuf, PathBuf) {
        let (s, u) = paths(name);
        (T { d: Daemon::load_with_usage(&s, &u), p: Fake::default(), mono: 0, k: 0 }, s, u)
    }
    fn call(&mut self, line: &str) -> Value {
        serde_json::from_str(&self.d.handle_line(line, wall(self.k), self.mono, [0; 16], &mut self.p)).unwrap()
    }
    fn report_day(&mut self, k: i64, exe: &str, title: Option<&str>) {
        self.k = k;
        let line = json!({"type":"ReportForeground","exe":exe,"title":title,"idle_secs":0,"day":day(k)}).to_string();
        assert_eq!(self.call(&line)["type"], "Ok");
    }
    /// Anchors, then accounts `secs` seconds on day `k` in steps of at most 10 s.
    fn feed(&mut self, k: i64, exe: &str, title: Option<&str>, secs: u64) {
        self.report_day(k, exe, title);
        let mut left = secs;
        while left > 0 {
            let step = left.min(10);
            self.mono += step as i64 * 1000;
            self.report_day(k, exe, title);
            left -= step;
        }
    }
    fn push(&mut self, limits: Value) -> Value {
        self.call(&json!({"type":"PushLimits","limits":limits}).to_string())
    }
    fn status(&mut self) -> Value {
        self.call(r#"{"type":"GetStatus"}"#)
    }
    fn get_limits(&mut self) -> Value {
        self.call(r#"{"type":"GetLimits"}"#)
    }
}

fn lim(id: &str, apps: &[&str], sites: &[&str], period: &str, cap: u64) -> Value {
    json!({"id":id,"name":"L","apps":apps,"sites":sites,"period":period,"cap_secs":cap,"lock":"none"})
}

fn block_apps(st: &Value) -> Vec<String> {
    st["decision"]["blockApps"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
}

#[test]
fn daily_limit_blocks_exactly_at_cap_and_lifts_next_day() {
    let (mut t, _, _) = T::new("daily");
    let r = t.push(json!([lim("limit-a", &["game.exe"], &[], "daily", 3600)]));
    assert_eq!(r, json!({"type":"LimitsPushed","applied":1,"kept_locked":[],"skipped_tombstoned":[]}));
    t.feed(0, "game.exe", None, 3599);
    let st = t.status();
    assert!(block_apps(&st).is_empty(), "{st}");
    assert!(st["decision"].get("limitBlocks").is_none());
    t.feed(0, "game.exe", None, 1);
    let st = t.status();
    assert_eq!(block_apps(&st), vec!["game.exe"]);
    assert_eq!(st["decision"]["limitBlocks"], json!([{"id":"limit-a","until_day":day(1)}]));
    // A new day lifts it.
    t.report_day(1, "notepad.exe", None);
    let st = t.status();
    assert!(block_apps(&st).is_empty(), "{st}");
}

#[test]
fn weekly_limit_lifts_on_monday() {
    let (mut t, _, _) = T::new("weekly");
    t.push(json!([lim("limit-w", &["game.exe"], &[], "weekly", 120)]));
    // Sunday 2023-11-19 is day 5; Monday 2023-11-20 is day 6.
    t.feed(5, "game.exe", None, 120);
    let st = t.status();
    assert_eq!(block_apps(&st), vec!["game.exe"]);
    assert_eq!(st["decision"]["limitBlocks"][0]["until_day"], day(6));
    t.report_day(6, "notepad.exe", None);
    assert!(block_apps(&t.status()).is_empty());
}

#[test]
fn site_limit_blocks_domain_and_hosts_file() {
    let (mut t, _, _) = T::new("site");
    t.push(json!([lim("limit-y", &[], &["youtube.com"], "daily", 60)]));
    t.feed(0, "chrome.exe", Some("Cats - YouTube"), 60);
    let st = t.status();
    assert_eq!(st["decision"]["blockSites"], json!(["youtube.com"]));
    t.d.tick(wall(0), t.mono, &mut t.p);
    assert_eq!(t.p.hosts.last().unwrap(), &vec!["youtube.com".to_string()]);
}

#[test]
fn limit_domain_outside_the_site_map_counts_under_its_stem() {
    let (mut t, _, _) = T::new("acme");
    t.push(json!([lim("limit-acme", &[], &["acmecorp.com"], "daily", 60)]));
    t.feed(0, "chrome.exe", Some("Inbox | acmecorp"), 59);
    assert!(t.status()["decision"]["blockSites"].as_array().unwrap().is_empty());
    t.feed(0, "chrome.exe", Some("Inbox | acmecorp"), 1);
    assert_eq!(t.status()["decision"]["blockSites"], json!(["acmecorp.com"]));
    let l = t.get_limits();
    assert_eq!(l["status"][0]["used_secs"], 60);
}

#[test]
fn limit_never_relaxes_an_allow_window() {
    let (mut t, _, _) = T::new("allow");
    let w = json!({"id":"w","starts":wall(0)-1000,"ends":wall(0)+7_200_000,"lock":"none","mode":"allow","sites":[],"apps":["code.exe","game.exe"]});
    assert_eq!(t.call(&json!({"type":"PushWindows","windows":[w]}).to_string())["type"], "Ok");
    t.push(json!([lim("limit-a", &["game.exe"], &[], "daily", 60)]));
    t.feed(0, "game.exe", None, 60);
    let st = t.status();
    assert_eq!(st["decision"]["allow"]["apps"], json!(["code.exe", "game.exe"]));
    assert_eq!(block_apps(&st), vec!["game.exe"]);
    assert_eq!(st["decision"]["limitBlocks"][0]["id"], "limit-a");
}

#[test]
fn earlier_day_report_does_not_lower_used_or_lift_block() {
    let (mut t, _, _) = T::new("back");
    t.push(json!([lim("limit-a", &["game.exe"], &[], "daily", 100)]));
    t.feed(1, "game.exe", None, 100);
    assert_eq!(block_apps(&t.status()), vec!["game.exe"]);
    // The clock goes back a day: still blocked, used time unchanged by the new report's day.
    t.report_day(0, "notepad.exe", None);
    t.mono += 1000;
    t.report_day(0, "notepad.exe", None);
    let st = t.status();
    assert_eq!(block_apps(&st), vec!["game.exe"], "{st}");
    let l = t.get_limits();
    assert_eq!(l["status"][0]["used_secs"], 100);
    assert_eq!(l["status"][0]["period_ends_day"], day(2));
}

#[test]
fn no_report_yet_means_no_block() {
    let (s, u) = paths("noreport");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake::default();
    let mut s_ = DayUsage { day: day(0), total: 500, ..Default::default() };
    s_.apps.insert("game.exe".into(), 500);
    d.add_usage(s_);
    let call = |d: &mut Daemon, p: &mut Fake, l: &str| -> Value {
        serde_json::from_str(&d.handle_line(l, wall(0), 0, [0; 16], p)).unwrap()
    };
    call(&mut d, &mut p, &json!({"type":"PushLimits","limits":[lim("limit-a", &["game.exe"], &[], "daily", 100)]}).to_string());
    let st = call(&mut d, &mut p, r#"{"type":"GetStatus"}"#);
    assert!(block_apps(&st).is_empty());
    assert!(call(&mut d, &mut p, r#"{"type":"GetLimits"}"#)["status"].as_array().unwrap().is_empty());
    // The first report fixes the day: seeded usage counts and the limit blocks.
    let line = json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":day(0)}).to_string();
    call(&mut d, &mut p, &line);
    let st = call(&mut d, &mut p, r#"{"type":"GetStatus"}"#);
    assert_eq!(block_apps(&st), vec!["game.exe"]);
}

#[test]
fn get_limits_reports_status() {
    let (mut t, _, _) = T::new("get");
    t.push(json!([lim("limit-a", &["game.exe"], &[], "daily", 100), lim("limit-b", &["a.exe"], &[], "weekly", 5000)]));
    t.feed(0, "game.exe", None, 40);
    let l = t.get_limits();
    assert_eq!(l["type"], "Limits");
    assert_eq!(l["limits"].as_array().unwrap().len(), 2);
    assert_eq!(l["pending_unlocks"], json!([]));
    let a = l["status"].as_array().unwrap().iter().find(|s| s["id"] == "limit-a").unwrap().clone();
    assert_eq!(a, json!({"id":"limit-a","used_secs":40,"cap_secs":100,"blocked":false,"period_ends_day":day(1)}));
    let b = l["status"].as_array().unwrap().iter().find(|s| s["id"] == "limit-b").unwrap().clone();
    assert_eq!(b["period_ends_day"], day(6));
    t.feed(0, "game.exe", None, 60);
    let l = t.get_limits();
    let a = l["status"].as_array().unwrap().iter().find(|s| s["id"] == "limit-a").unwrap().clone();
    assert_eq!(a["used_secs"], 100);
    assert_eq!(a["blocked"], true);
}

#[test]
fn push_reports_kept_locked_and_rejects_bad_limits() {
    let (mut t, _, _) = T::new("push");
    let r = t.push(json!([{"id":"limit-a","name":"L","apps":["a.exe"],"sites":[],"period":"daily","cap_secs":5,"lock":"none"}]));
    assert_eq!(r["type"], "Error");
    assert_eq!(r["code"], "bad-limit");
    assert_eq!(r["message"], "bad-cap");
    let r = t.push(json!([{"id":"limit-a","name":"L","apps":["a.exe"],"sites":[],"period":"daily","cap_secs":600,"lock":"locked","unlock_delay_ms":3_600_000}]));
    assert_eq!(r["code"], "no-partner");
    assert_eq!(t.get_limits()["limits"], json!([]));
}

#[test]
fn limits_survive_restart() {
    let (mut t, s, u) = T::new("restart");
    t.push(json!([lim("limit-a", &["game.exe"], &[], "daily", 100)]));
    t.feed(0, "game.exe", None, 100);
    t.d.flush_usage();
    let mut d2 = Daemon::load_with_usage(&s, &u);
    let mut p = Fake::default();
    {
        let mut call = |l: &str| -> Value { serde_json::from_str(&d2.handle_line(l, wall(0), 0, [0; 16], &mut p)).unwrap() };
        // Before any report the persisted usage keeps the block.
        let g = call(r#"{"type":"GetLimits"}"#);
        assert_eq!(g["limits"][0]["id"], "limit-a");
        assert_eq!(g["status"][0]["blocked"], true);
        assert_eq!(block_apps(&call(r#"{"type":"GetStatus"}"#)), vec!["game.exe"]);
        let line = json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":day(0)}).to_string();
        call(&line);
        assert_eq!(block_apps(&call(r#"{"type":"GetStatus"}"#)), vec!["game.exe"]);
        // A report on a later day lifts it.
        let line = json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":day(1)}).to_string();
        call(&line);
        assert!(block_apps(&call(r#"{"type":"GetStatus"}"#)).is_empty());
    }
}

#[test]
fn restart_enforces_sites_before_first_report() {
    let (mut t, s, u) = T::new("restart-sites");
    t.push(json!([lim("limit-y", &[], &["youtube.com"], "daily", 60)]));
    t.feed(0, "chrome.exe", Some("Cats - YouTube"), 60);
    t.d.flush_usage();
    let mut d2 = Daemon::load_with_usage(&s, &u);
    let mut p = Fake::default();
    d2.tick(wall(0), 0, &mut p);
    assert_eq!(p.hosts.last().unwrap(), &vec!["youtube.com".to_string()]);
}

#[test]
fn forward_day_report_does_not_lift_or_move_the_day() {
    let (mut t, _, _) = T::new("ratchet");
    t.push(json!([lim("limit-a", &["game.exe"], &[], "daily", 100)]));
    t.feed(0, "game.exe", None, 100);
    assert_eq!(block_apps(&t.status()), vec!["game.exe"]);
    // today + 2 is recorded but ignored as the current day.
    t.k = 0;
    let line = json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":day(2)}).to_string();
    t.mono += 1000;
    assert_eq!(t.call(&line)["type"], "Ok");
    assert_eq!(block_apps(&t.status()), vec!["game.exe"]);
    assert_eq!(t.get_limits()["status"][0]["period_ends_day"], day(1));
    // today + 1 (a zone ahead of UTC) is accepted and lifts the daily block.
    let line = json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":day(1)}).to_string();
    t.mono += 1000;
    t.call(&line);
    assert!(block_apps(&t.status()).is_empty());
    assert_eq!(t.get_limits()["status"][0]["period_ends_day"], day(2));
}

#[test]
fn weekly_limit_sums_several_days() {
    let (mut t, _, _) = T::new("sum");
    t.push(json!([lim("limit-w", &["game.exe"], &[], "weekly", 90)]));
    t.feed(-1, "game.exe", None, 30); // Monday 2023-11-13
    t.feed(0, "game.exe", None, 30);
    assert!(block_apps(&t.status()).is_empty());
    t.feed(0, "game.exe", None, 30);
    assert_eq!(block_apps(&t.status()), vec!["game.exe"]);
    assert_eq!(t.get_limits()["status"][0]["used_secs"], 90);
}

#[test]
fn until_day_rolls_over_month_and_year() {
    // Seed persisted usage so the restarted daemon's current day is the boundary day.
    for (seed_day, period, want) in [
        ("2023-11-30", "daily", "2023-12-01"),
        ("2023-12-31", "daily", "2024-01-01"),
        ("2023-12-31", "weekly", "2024-01-01"), // Sunday
        ("2023-11-30", "weekly", "2023-12-04"), // Thursday
    ] {
        let (s, u) = paths(&format!("until-{seed_day}-{period}"));
        let mut d = Daemon::load_with_usage(&s, &u);
        let mut p = Fake::default();
        let mut du = DayUsage { day: seed_day.into(), total: 60, ..Default::default() };
        du.apps.insert("game.exe".into(), 60);
        d.add_usage(du);
        let mut d = Daemon::load_with_usage(&s, &u);
        let l = json!({"type":"PushLimits","limits":[lim("limit-a", &["game.exe"], &[], period, 60)]}).to_string();
        d.handle_line(&l, wall(0), 0, [0; 16], &mut p);
        let st: Value = serde_json::from_str(&d.handle_line(r#"{"type":"GetStatus"}"#, wall(0), 0, [0; 16], &mut p)).unwrap();
        assert_eq!(st["decision"]["limitBlocks"][0]["until_day"], want, "{seed_day} {period}");
    }
}
