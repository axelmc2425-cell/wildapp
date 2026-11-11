use std::io;
use std::path::PathBuf;

use focus_helper::daemon::{Daemon, Platform};
use focus_helper::enforce::{Proc, ProcessTable};
use focus_helper::usage::DayUsage;
use serde_json::{json, Value};

const NOW: i64 = 1_700_000_000_000;

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
struct Fake;

impl Platform for Fake {
    fn enforce_hosts(&mut self, _: &[String]) -> io::Result<bool> {
        Ok(false)
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
    let d = std::env::temp_dir().join(format!("focus-usage-proto-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    (d.join("state.json"), d.join("usage.json"))
}

/// A `ReportForeground` request line for chrome with the given title.
fn chrome(title: &str) -> String {
    report("chrome.exe", Some(title), 0)
}

fn report(exe: &str, title: Option<&str>, idle: u64) -> String {
    json!({"type":"ReportForeground","exe":exe,"title":title,"idle_secs":idle,"day":"2026-11-11"}).to_string()
}

/// Sends the report at monotonic `mono` ms.
fn rep(d: &mut Daemon, p: &mut Fake, line: &str, mono: i64) -> Value {
    call(d, p, line, mono)
}

fn call(d: &mut Daemon, p: &mut Fake, line: &str, mono: i64) -> Value {
    serde_json::from_str(&d.handle_line(line, NOW + mono, mono, [0; 16], p)).unwrap()
}

fn usage(d: &mut Daemon, p: &mut Fake) -> Value {
    call(d, p, r#"{"type":"GetUsage","from_day":"2026-11-01","to_day":"2026-11-30"}"#, 0)
}

#[test]
fn status_reports_usage_tracking() {
    let (s, u) = paths("status");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let st = r#"{"type":"GetStatus"}"#;
    assert_eq!(call(&mut d, &mut p, st, 0)["usage_tracking"], false, "no sampler yet");
    assert_eq!(rep(&mut d, &mut p, &chrome("Inbox"), 1_000)["type"], "Ok");
    assert_eq!(call(&mut d, &mut p, st, 1_000)["usage_tracking"], true);
    assert_eq!(call(&mut d, &mut p, st, 16_000)["usage_tracking"], true, "exactly 15 s after is still tracking");
    assert_eq!(call(&mut d, &mut p, st, 16_001)["usage_tracking"], false, "no report for more than 15 s");
    rep(&mut d, &mut p, &chrome("Inbox"), 20_000);
    assert_eq!(call(&mut d, &mut p, st, 20_000)["usage_tracking"], true, "a new report resumes it");
}

#[test]
fn reports_every_five_seconds() {
    let (s, u) = paths("every5");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for mono in [0, 5_000, 10_000] {
        assert_eq!(rep(&mut d, &mut p, &chrome("Inbox"), mono)["type"], "Ok");
    }
    // The first report only anchors.
    let r = usage(&mut d, &mut p);
    assert_eq!(r["days"][0]["total"], 10);
    assert_eq!(r["days"][0]["apps"]["chrome.exe"], 10);
}

#[test]
fn first_report_records_nothing() {
    let (s, u) = paths("first");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    rep(&mut d, &mut p, &chrome("Inbox"), 0);
    assert_eq!(usage(&mut d, &mut p)["days"], json!([]));
}

#[test]
fn reports_less_than_four_seconds_apart_count_once() {
    let (s, u) = paths("double");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    rep(&mut d, &mut p, &chrome("Inbox"), 0);
    // Two signed-in users: each sampler reports every 5 s, interleaved 1 s apart.
    rep(&mut d, &mut p, &chrome("Inbox"), 5_000);
    rep(&mut d, &mut p, &chrome("Inbox"), 6_000);
    rep(&mut d, &mut p, &chrome("Inbox"), 10_000);
    rep(&mut d, &mut p, &chrome("Inbox"), 11_000);
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 10);
    // The anchor stays at 10 s: a report 3.999 s later counts nothing.
    rep(&mut d, &mut p, &chrome("Inbox"), 13_999);
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 10);
}

#[test]
fn no_reports_means_nothing_counted_even_with_ticks() {
    let (s, u) = paths("noreports");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for mono in [0, 5_000, 10_000] {
        d.tick(NOW + mono, mono, &mut p);
    }
    assert_eq!(usage(&mut d, &mut p)["days"], json!([]));
}


#[test]
fn suspend_gap_capped() {
    let (s, u) = paths("gap");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    rep(&mut d, &mut p, &chrome("Inbox"), 0);
    rep(&mut d, &mut p, &chrome("Inbox"), 600_000);
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 15);
}

#[test]
fn block_list_stem_used() {
    let (s, u) = paths("stem");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let w = json!({"id":"w","starts":NOW-1000,"ends":NOW+3_600_000,"lock":"none","mode":"block","sites":["acmecorp.com"],"apps":[]});
    let r = call(&mut d, &mut p, &json!({"type":"PushWindows","windows":[w]}).to_string(), 0);
    assert_eq!(r["type"], "Ok");
    rep(&mut d, &mut p, &chrome("Inbox | acmecorp"), 0);
    rep(&mut d, &mut p, &chrome("Inbox | acmecorp"), 5_000);
    let r = usage(&mut d, &mut p);
    assert_eq!(r["days"][0]["sites"]["acmecorp"], 5);
}

#[test]
fn get_usage_shape() {
    let (s, u) = paths("shape");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    d.add_usage(DayUsage { day: "2026-11-10".into(), total: 60, ..Default::default() });
    let r = usage(&mut d, &mut p);
    assert_eq!(r["type"], "Usage");
    let day = r["days"][0].as_object().unwrap();
    let mut keys: Vec<&str> = day.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["apps", "day", "other_browsing", "sites", "total"]);
}

#[test]
fn get_usage_rejects() {
    let (s, u) = paths("rejects");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for (f, t) in [("2026-11-30", "2026-11-01"), ("nope", "2026-11-01"), ("2025-01-01", "2026-02-05")] {
        let r = call(&mut d, &mut p, &json!({"type":"GetUsage","from_day":f,"to_day":t}).to_string(), 0);
        assert_eq!(r["type"], "Error", "{f}..{t}");
        assert_eq!(r["code"], "bad-request");
    }
}

#[test]
fn usage_persists_and_flushes() {
    let (s, u) = paths("flush");
    {
        let mut d = Daemon::load_with_usage(&s, &u);
        let mut p = Fake;
        rep(&mut d, &mut p, &chrome("Inbox"), 0);
        rep(&mut d, &mut p, &chrome("Inbox"), 5_000);
        assert!(!u.exists(), "not saved before the minute is up");
        d.flush_usage();
    }
    assert!(u.exists());
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 5);
}

#[test]
fn usage_saved_once_a_minute_when_dirty() {
    let (s, u) = paths("minute");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for mono in (0..60_000).step_by(5_000) {
        rep(&mut d, &mut p, &chrome("Inbox"), mono);
        d.tick(NOW + mono, mono, &mut p);
    }
    assert!(!u.exists(), "still inside the first minute");
    rep(&mut d, &mut p, &chrome("Inbox"), 60_000);
    d.tick(NOW + 60_000, 60_000, &mut p);
    assert!(u.exists());
}

#[test]
fn unreadable_usage_file_warns_without_titles() {
    let (s, u) = paths("corrupt");
    std::fs::write(&u, b"garbage").unwrap();
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let st = call(&mut d, &mut p, r#"{"type":"GetStatus"}"#, 0);
    let w = st["warnings"][0].as_str().unwrap();
    assert!(w.starts_with("usage: unreadable, started empty — previous file kept as "), "{w}");
    assert!(w.contains("usage.json.corrupt-"), "{w}");
}

#[test]
fn load_derives_usage_path_next_to_state() {
    let (s, u) = paths("derive");
    let mut d = Daemon::load(&s);
    d.add_usage(DayUsage { day: "2026-11-10".into(), total: 7, ..Default::default() });
    assert!(u.exists());
}

fn stem_total(window: Value, name: &str) -> Option<u64> {
    let (s, u) = paths(name);
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let r = call(&mut d, &mut p, &json!({"type":"PushWindows","windows":[window]}).to_string(), 0);
    assert_eq!(r["type"], "Ok");
    rep(&mut d, &mut p, &chrome("Inbox | acmecorp"), 0);
    rep(&mut d, &mut p, &chrome("Inbox | acmecorp"), 5_000);
    usage(&mut d, &mut p)["days"][0]["sites"]["acmecorp"].as_u64()
}

#[test]
fn allow_window_site_is_not_a_stem() {
    let w = json!({"id":"w","starts":NOW-1000,"ends":NOW+3_600_000,"lock":"none","mode":"allow","sites":["acmecorp.com"],"apps":["code.exe"]});
    assert_eq!(stem_total(w, "allow"), None);
}

#[test]
fn expired_block_window_is_not_a_stem() {
    let w = json!({"id":"w","starts":NOW-3_600_000,"ends":NOW-1000,"lock":"none","mode":"block","sites":["acmecorp.com"],"apps":[]});
    assert_eq!(stem_total(w, "expired"), None);
}

#[test]
fn active_block_window_is_a_stem() {
    let w = json!({"id":"w","starts":NOW-1000,"ends":NOW+3_600_000,"lock":"none","mode":"block","sites":["acmecorp.com"],"apps":[]});
    assert_eq!(stem_total(w, "active"), Some(5));
}

#[test]
fn sub_second_remainder_is_carried() {
    let (s, u) = paths("remainder");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for i in 0..6 {
        rep(&mut d, &mut p, &chrome("Inbox"), i * 5_999);
    }
    // 5 reports after the anchor, spanning 29 995 ms: 29 whole seconds, not 25.
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 29);
}

#[test]
fn idle_report_counts_nothing() {
    let (s, u) = paths("idle");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    rep(&mut d, &mut p, &report("chrome.exe", None, 301), 0);
    rep(&mut d, &mut p, &report("chrome.exe", None, 301), 5_000);
    assert_eq!(usage(&mut d, &mut p)["days"], json!([]));
}

#[test]
fn report_validation_errors() {
    let (s, u) = paths("validate");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let long_exe = "a".repeat(261);
    let long_title = "t".repeat(1025);
    let cases = [
        json!({"type":"ReportForeground","exe":"","title":null,"idle_secs":0,"day":"2026-11-11"}),
        json!({"type":"ReportForeground","exe":long_exe,"title":null,"idle_secs":0,"day":"2026-11-11"}),
        json!({"type":"ReportForeground","exe":"C:\\x\\a.exe","title":null,"idle_secs":0,"day":"2026-11-11"}),
        json!({"type":"ReportForeground","exe":"dir/a.exe","title":null,"idle_secs":0,"day":"2026-11-11"}),
        json!({"type":"ReportForeground","exe":"a.exe","title":long_title,"idle_secs":0,"day":"2026-11-11"}),
        json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":"2026-13-01"}),
        json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":"nope"}),
    ];
    for c in cases {
        let r = call(&mut d, &mut p, &c.to_string(), 0);
        assert_eq!(r["type"], "Error", "{c}");
        assert_eq!(r["code"], "bad-request", "{c}");
        let text = r.to_string();
        assert!(!text.contains(&"t".repeat(50)), "the title is never echoed");
    }
    // Rejected reports neither anchor nor mark the sampler as running.
    assert_eq!(call(&mut d, &mut p, r#"{"type":"GetStatus"}"#, 0)["usage_tracking"], false);
    // Boundary values are accepted.
    let ok = json!({"type":"ReportForeground","exe":"a".repeat(260),"title":"t".repeat(1024),"idle_secs":0,"day":"2026-11-11"});
    assert_eq!(call(&mut d, &mut p, &ok.to_string(), 0)["type"], "Ok");
}

#[test]
fn report_foreground_does_not_write_state() {
    let (s, u) = paths("reportnowrite");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    rep(&mut d, &mut p, &chrome("Inbox"), 0);
    rep(&mut d, &mut p, &chrome("Inbox"), 5_000);
    assert!(!s.exists());
    std::fs::write(&s, b"{}").unwrap();
    rep(&mut d, &mut p, &chrome("Inbox"), 10_000);
    assert_eq!(std::fs::read(&s).unwrap(), b"{}");
}

#[test]
fn get_usage_does_not_write_state() {
    let (s, u) = paths("nowrite");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    usage(&mut d, &mut p);
    assert!(!s.exists());
    std::fs::write(&s, b"{}").unwrap();
    usage(&mut d, &mut p);
    assert_eq!(std::fs::read(&s).unwrap(), b"{}");
}

#[test]
fn failed_usage_save_warns_then_clears() {
    let (s, _) = paths("saveerr");
    let dir = s.with_file_name("missing");
    let u = dir.join("usage.json");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    d.add_usage(DayUsage { day: "2026-11-10".into(), total: 7, ..Default::default() });
    let st = call(&mut d, &mut p, r#"{"type":"GetStatus"}"#, 0);
    assert!(st["warnings"][0].as_str().unwrap().starts_with("usage: "), "{st}");
    std::fs::create_dir_all(&dir).unwrap();
    d.flush_usage();
    let st = call(&mut d, &mut p, r#"{"type":"GetStatus"}"#, 0);
    assert_eq!(st["warnings"], json!([]));
}

#[test]
fn backup_load_warns() {
    let (s, u) = paths("backup");
    {
        let mut d = Daemon::load_with_usage(&s, &u);
        d.add_usage(DayUsage { day: "2026-11-10".into(), total: 7, ..Default::default() });
        d.add_usage(DayUsage { day: "2026-11-10".into(), total: 8, ..Default::default() });
    }
    std::fs::write(&u, b"garbage").unwrap();
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let st = call(&mut d, &mut p, r#"{"type":"GetStatus"}"#, 0);
    let w = st["warnings"][0].as_str().unwrap();
    assert!(w.starts_with("usage: loaded from backup"), "{w}");
    assert!(w.contains("usage.json.corrupt-"), "{w}");
}
