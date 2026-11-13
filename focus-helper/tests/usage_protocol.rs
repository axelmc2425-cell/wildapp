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
    json!({"type":"ReportForeground","exe":exe,"title":title,"idle_secs":idle,"day":"2023-11-14"}).to_string()
}

fn report_hour(hour: Value) -> String {
    json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":"2023-11-14","hour":hour}).to_string()
}

fn call(d: &mut Daemon, p: &mut Fake, line: &str, mono: i64) -> Value {
    serde_json::from_str(&d.handle_line(line, NOW + mono, mono, [0; 16], p)).unwrap()
}

fn usage(d: &mut Daemon, p: &mut Fake) -> Value {
    call(d, p, r#"{"type":"GetUsage","from_day":"2023-11-01","to_day":"2023-11-30"}"#, 0)
}

#[test]
fn status_reports_usage_tracking() {
    let (s, u) = paths("status");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let st = r#"{"type":"GetStatus"}"#;
    assert_eq!(call(&mut d, &mut p, st, 0)["usage_tracking"], false, "no sampler yet");
    assert_eq!(call(&mut d, &mut p, &chrome("Inbox"), 1_000)["type"], "Ok");
    assert_eq!(call(&mut d, &mut p, st, 1_000)["usage_tracking"], true);
    assert_eq!(call(&mut d, &mut p, st, 16_000)["usage_tracking"], true, "exactly 15 s after is still tracking");
    assert_eq!(call(&mut d, &mut p, st, 16_001)["usage_tracking"], false, "no report for more than 15 s");
    call(&mut d, &mut p, &chrome("Inbox"), 20_000);
    assert_eq!(call(&mut d, &mut p, st, 20_000)["usage_tracking"], true, "a new report resumes it");
}

#[test]
fn reports_every_second() {
    let (s, u) = paths("every1");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for mono in (0..=10).map(|i| i * 1_000) {
        assert_eq!(call(&mut d, &mut p, &chrome("Inbox"), mono)["type"], "Ok");
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
    call(&mut d, &mut p, &chrome("Inbox"), 0);
    assert_eq!(usage(&mut d, &mut p)["days"], json!([]));
}

#[test]
fn reports_less_than_one_second_apart_count_once() {
    let (s, u) = paths("double");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    call(&mut d, &mut p, &chrome("Inbox"), 0);
    // Two signed-in users: each sampler reports every 1 s, interleaved 0.5 s apart.
    call(&mut d, &mut p, &chrome("Inbox"), 5_000);
    call(&mut d, &mut p, &chrome("Inbox"), 5_500);
    call(&mut d, &mut p, &chrome("Inbox"), 10_000);
    call(&mut d, &mut p, &chrome("Inbox"), 10_500);
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 10);
    // The anchor stays at 10 s: a report 0.999 s later counts nothing.
    call(&mut d, &mut p, &chrome("Inbox"), 10_999);
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 10);
}

#[test]
fn one_second_boundary() {
    let total = |name: &str, monos: &[i64]| {
        let (s, u) = paths(name);
        let mut d = Daemon::load_with_usage(&s, &u);
        let mut p = Fake;
        for m in monos {
            call(&mut d, &mut p, &chrome("Inbox"), *m);
        }
        usage(&mut d, &mut p)["days"][0]["total"].as_u64().unwrap_or(0)
    };
    assert_eq!(total("b1000", &[0, 1_000]), 1, "exactly 1 s counts");
    assert_eq!(total("b999", &[0, 999]), 0, "0.999 s counts nothing");
    assert_eq!(total("b999late", &[0, 999, 2_000]), 2, "the ignored report is not lost");
    assert_eq!(total("b900", &[0, 900, 2_000]), 2);
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
    call(&mut d, &mut p, &chrome("Inbox"), 0);
    call(&mut d, &mut p, &chrome("Inbox"), 600_000);
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
    call(&mut d, &mut p, &chrome("Inbox | acmecorp"), 0);
    call(&mut d, &mut p, &chrome("Inbox | acmecorp"), 5_000);
    let r = usage(&mut d, &mut p);
    assert_eq!(r["days"][0]["sites"]["acmecorp"], 5);
}

#[test]
fn get_usage_shape() {
    let (s, u) = paths("shape");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    d.add_usage(DayUsage { day: "2023-11-10".into(), total: 60, ..Default::default() });
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
    for (f, t) in [("2023-11-30", "2023-11-01"), ("nope", "2023-11-01"), ("2025-01-01", "2026-02-05")] {
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
        call(&mut d, &mut p, &chrome("Inbox"), 0);
        call(&mut d, &mut p, &chrome("Inbox"), 5_000);
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
        call(&mut d, &mut p, &chrome("Inbox"), mono);
        d.tick(NOW + mono, mono, &mut p);
    }
    assert!(!u.exists(), "still inside the first minute");
    call(&mut d, &mut p, &chrome("Inbox"), 60_000);
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
    d.add_usage(DayUsage { day: "2023-11-10".into(), total: 7, ..Default::default() });
    assert!(u.exists());
}

fn stem_total(window: Value, name: &str) -> Option<u64> {
    let (s, u) = paths(name);
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let r = call(&mut d, &mut p, &json!({"type":"PushWindows","windows":[window]}).to_string(), 0);
    assert_eq!(r["type"], "Ok");
    call(&mut d, &mut p, &chrome("Inbox | acmecorp"), 0);
    call(&mut d, &mut p, &chrome("Inbox | acmecorp"), 5_000);
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
        call(&mut d, &mut p, &chrome("Inbox"), i * 5_999);
    }
    // 5 reports after the anchor, spanning 29 995 ms: 29 whole seconds, not 25.
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 29);
}

#[test]
fn idle_report_counts_nothing() {
    let (s, u) = paths("idle");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    call(&mut d, &mut p, &report("chrome.exe", None, 301), 0);
    call(&mut d, &mut p, &report("chrome.exe", None, 301), 5_000);
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
        json!({"type":"ReportForeground","exe":"","title":null,"idle_secs":0,"day":"2023-11-14"}),
        json!({"type":"ReportForeground","exe":long_exe,"title":null,"idle_secs":0,"day":"2023-11-14"}),
        json!({"type":"ReportForeground","exe":"C:\\x\\a.exe","title":null,"idle_secs":0,"day":"2023-11-14"}),
        json!({"type":"ReportForeground","exe":"dir/a.exe","title":null,"idle_secs":0,"day":"2023-11-14"}),
        json!({"type":"ReportForeground","exe":"a.exe","title":long_title,"idle_secs":0,"day":"2023-11-14"}),
        json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":"2023-13-01"}),
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
    let ok = json!({"type":"ReportForeground","exe":"a".repeat(260),"title":"t".repeat(1024),"idle_secs":0,"day":"2023-11-14"});
    assert_eq!(call(&mut d, &mut p, &ok.to_string(), 0)["type"], "Ok");
}

#[test]
fn report_foreground_does_not_write_state() {
    let (s, u) = paths("reportnowrite");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    call(&mut d, &mut p, &chrome("Inbox"), 0);
    call(&mut d, &mut p, &chrome("Inbox"), 5_000);
    assert!(!s.exists());
    std::fs::write(&s, b"{}").unwrap();
    call(&mut d, &mut p, &chrome("Inbox"), 10_000);
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
    d.add_usage(DayUsage { day: "2023-11-10".into(), total: 7, ..Default::default() });
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
        d.add_usage(DayUsage { day: "2023-11-10".into(), total: 7, ..Default::default() });
        d.add_usage(DayUsage { day: "2023-11-10".into(), total: 8, ..Default::default() });
    }
    std::fs::write(&u, b"garbage").unwrap();
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let st = call(&mut d, &mut p, r#"{"type":"GetStatus"}"#, 0);
    let w = st["warnings"][0].as_str().unwrap();
    assert!(w.starts_with("usage: loaded from backup"), "{w}");
    assert!(w.contains("usage.json.corrupt-"), "{w}");
}

#[test]
fn future_block_window_is_not_a_stem() {
    let w = json!({"id":"w","starts":NOW+60_000,"ends":NOW+3_600_000,"lock":"none","mode":"block","sites":["acmecorp.com"],"apps":[]});
    assert_eq!(stem_total(w, "future"), None);
}

#[test]
fn usage_file_contains_no_title_text() {
    let (s, u) = paths("notitle");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    call(&mut d, &mut p, &chrome("SecretTitleXyzzy - Mozilla"), 0);
    call(&mut d, &mut p, &chrome("SecretTitleXyzzy - Mozilla"), 5_000);
    d.flush_usage();
    let text = std::fs::read_to_string(&u).unwrap();
    assert!(text.contains("chrome.exe"));
    assert!(!text.contains("Xyzzy") && !text.contains("Secret"), "{text}");
}

fn report_day(d: &mut Daemon, day: &str) -> Value {
    let line = json!({"type":"ReportForeground","exe":"a.exe","title":null,"idle_secs":0,"day":day}).to_string();
    serde_json::from_str(&d.handle_line(&line, NOW, 0, [0; 16], &mut Fake)).unwrap()
}

#[test]
fn report_day_must_be_near_the_wall_clock_date() {
    // NOW is 2023-11-14 22:13 UTC.
    let (s, u) = paths("dayskew");
    let mut d = Daemon::load_with_usage(&s, &u);
    for ok in ["2023-11-14", "2023-11-15", "2023-11-13", "2023-11-16", "2023-11-12"] {
        assert_eq!(report_day(&mut d, ok)["type"], "Ok", "{ok}");
    }
    for bad in ["2023-11-17", "2023-11-11", "2026-11-11", "1999-01-01"] {
        let r = report_day(&mut d, bad);
        assert_eq!(r["type"], "Error", "{bad}");
        assert_eq!(r["code"], "bad-request", "{bad}");
    }
}

#[test]
fn rejected_far_day_changes_nothing() {
    let (s, u) = paths("dayreject");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    call(&mut d, &mut p, &chrome("Inbox"), 0);
    call(&mut d, &mut p, &chrome("Inbox"), 5_000);
    let far = json!({"type":"ReportForeground","exe":"chrome.exe","title":null,"idle_secs":0,"day":"2023-11-20"}).to_string();
    assert_eq!(call(&mut d, &mut p, &far, 10_000)["type"], "Error");
    assert_eq!(call(&mut d, &mut p, &far, 20_000)["type"], "Error");
    let r = usage(&mut d, &mut p);
    assert_eq!(r["days"].as_array().unwrap().len(), 1);
    assert_eq!(r["days"][0]["total"], 5);
    // The rejected reports did not move the anchor: the next good one counts the whole gap (capped at 15).
    call(&mut d, &mut p, &chrome("Inbox"), 25_000);
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 20);
}

#[test]
fn report_with_hour_ok() {
    let (s, u) = paths("hour-ok");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    assert_eq!(call(&mut d, &mut p, &report_hour(json!(14)), 0)["type"], "Ok");
    assert_eq!(call(&mut d, &mut p, &report_hour(json!(14)), 5_000)["type"], "Ok");
    let r = usage(&mut d, &mut p);
    assert_eq!(r["days"][0]["hours"][14], 5);
}

#[test]
fn report_with_hour_24_is_bad_request() {
    let (s, u) = paths("hour-24");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let r = call(&mut d, &mut p, &report_hour(json!(24)), 0);
    assert_eq!(r["type"], "Error");
    assert_eq!(r["code"], "bad-request");
    assert_eq!(r["message"], "hour must be 0 to 23");
}

#[test]
fn report_without_hour_still_ok() {
    let (s, u) = paths("hour-none");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    assert_eq!(call(&mut d, &mut p, &report("a.exe", None, 0), 0)["type"], "Ok");
    call(&mut d, &mut p, &report("a.exe", None, 0), 5_000);
    let r = usage(&mut d, &mut p);
    assert_eq!(r["days"][0]["total"], 5);
    assert!(r["days"][0].get("hours").is_none(), "unrecorded hours are omitted");
}

#[test]
fn get_usage_rows_include_hours() {
    let (s, u) = paths("hour-rows");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let mut hours = vec![0u32; 24];
    hours[9] = 7;
    d.add_usage(DayUsage { day: "2023-11-10".into(), total: 7, hours, ..Default::default() });
    let r = usage(&mut d, &mut p);
    assert_eq!(r["days"][0]["hours"].as_array().unwrap().len(), 24);
    assert_eq!(r["days"][0]["hours"][9], 7);
}

fn sessions(d: &mut Daemon, p: &mut Fake, day: &str) -> Value {
    call(d, p, &json!({"type":"GetSessions","day":day}).to_string(), 0)
}

#[test]
fn one_second_reports_make_one_stretch() {
    let (s, u) = paths("st-one");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for m in 0..=5 {
        call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
    }
    let r = sessions(&mut d, &mut p, "2023-11-14");
    assert_eq!(r["type"], "Sessions");
    assert_eq!(r["day"], "2023-11-14");
    assert_eq!(r["truncated"], false);
    let st = r["stretches"].as_array().unwrap();
    assert_eq!(st.len(), 1, "{r}");
    assert_eq!(st[0]["exe"], "a.exe");
    assert_eq!(st[0]["site"], Value::Null);
    assert_eq!(st[0]["start"], NOW / 1000 + 0);
    assert_eq!(st[0]["end"], NOW / 1000 + 5);
}

#[test]
fn switching_program_makes_two_stretches() {
    let (s, u) = paths("st-two");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for m in 0..=3 {
        call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
    }
    for m in 4..=6 {
        call(&mut d, &mut p, &report("b.exe", None, 0), m * 1000);
    }
    let r = sessions(&mut d, &mut p, "2023-11-14");
    let st = r["stretches"].as_array().unwrap();
    assert_eq!(st.len(), 2, "{r}");
    assert_eq!((st[0]["exe"].as_str(), st[1]["exe"].as_str()), (Some("a.exe"), Some("b.exe")));
    assert!(st[0]["end"].as_i64() <= st[1]["start"].as_i64());
}

#[test]
fn browser_site_title_sets_site() {
    let (s, u) = paths("st-site");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for m in 0..=3 {
        call(&mut d, &mut p, &chrome("Inbox - Gmail - Google Chrome"), m * 1000);
    }
    let r = sessions(&mut d, &mut p, "2023-11-14");
    let usage_sites = usage(&mut d, &mut p)["days"][0]["sites"].clone();
    let label = usage_sites.as_object().unwrap().keys().next().cloned();
    assert_eq!(r["stretches"][0]["site"].as_str().map(String::from), label, "{r} {usage_sites}");
    assert!(r["stretches"][0]["site"].is_string());
}

#[test]
fn idle_sample_ends_the_stretch() {
    let (s, u) = paths("st-idle");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for m in 0..=3 {
        call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
    }
    for m in 4..=9 {
        call(&mut d, &mut p, &report("a.exe", None, 400), m * 1000);
    }
    for m in 10..=12 {
        call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
    }
    let r = sessions(&mut d, &mut p, "2023-11-14");
    let st = r["stretches"].as_array().unwrap();
    assert_eq!(st.len(), 2, "{r}");
    assert_eq!(st[0]["end"], NOW / 1000 + 3);
    assert_eq!(st[1]["end"], NOW / 1000 + 12);
}

#[test]
fn empty_day_and_bad_day() {
    let (s, u) = paths("st-empty");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let r = sessions(&mut d, &mut p, "2023-11-01");
    assert_eq!(r, json!({"type":"Sessions","day":"2023-11-01","truncated":false,"stretches":[]}));
    for bad in ["x", "2023-13-01", "../state"] {
        let r = sessions(&mut d, &mut p, bad);
        assert_eq!((r["type"].as_str(), r["code"].as_str()), (Some("Error"), Some("bad-request")), "{bad}");
    }
}

#[test]
fn stretches_survive_restart_and_prune_deletes_old_files() {
    let (s, u) = paths("st-restart");
    {
        let mut d = Daemon::load_with_usage(&s, &u);
        let mut p = Fake;
        for m in 0..=4 {
            call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
        }
        d.flush_usage();
    }
    let dir = s.parent().unwrap();
    assert!(dir.join("sessions-2023-11-14.json").exists());
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let r = sessions(&mut d, &mut p, "2023-11-14");
    assert_eq!(r["stretches"].as_array().unwrap().len(), 1, "{r}");
    assert_eq!(r["stretches"][0]["end"], NOW / 1000 + 4);

    // 100 older days on disk: after a flush with new data only the newest 90 remain.
    let old: Vec<String> = (0..100)
        .map(|i| {
            let n = focus_helper::usage::day_number("2023-08-01").unwrap() + i;
            let (y, m, dd) = civil(n);
            format!("{y:04}-{m:02}-{dd:02}")
        })
        .collect();
    for day in &old {
        focus_helper::sessions::save_day(dir, day, &Default::default()).unwrap();
    }
    for m in 5..=8 {
        call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
    }
    d.flush_usage();
    let count = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json") && e.file_name().to_string_lossy().starts_with("sessions-"))
        .count();
    assert_eq!(count, 90);
    assert!(!dir.join(format!("sessions-{}.json", old[0])).exists(), "oldest deleted");
    assert!(dir.join("sessions-2023-11-14.json").exists(), "newest kept");
}

fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[test]
fn recording_after_restart_does_not_clobber_the_stored_day() {
    let (s, u) = paths("st-clobber");
    let dir = s.parent().unwrap().to_path_buf();
    {
        let mut d = Daemon::load_with_usage(&s, &u);
        let mut p = Fake;
        for m in 0..=4 {
            call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
        }
        d.flush_usage();
    }
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    // No GetSessions first: recording must load the stored day itself.
    for m in 10..=14 {
        call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
    }
    d.flush_usage();
    drop(d);
    let mut d = Daemon::load_with_usage(&s, &u);
    let r = sessions(&mut d, &mut p, "2023-11-14");
    let st = r["stretches"].as_array().unwrap();
    assert_eq!(st.first().unwrap()["start"], NOW / 1000, "old start kept: {r}");
    assert_eq!(st.last().unwrap()["end"], NOW / 1000 + 14, "new end: {r}");
    assert!(dir.join("sessions-2023-11-14.json").exists());
}

#[test]
fn session_flush_is_throttled_to_once_a_minute() {
    let (s, u) = paths("st-throttle");
    let file = s.parent().unwrap().join("sessions-2023-11-14.json");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for m in 0..=5 {
        call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
    }
    assert!(!file.exists(), "not written right away");
    d.tick(NOW + 59_999, 59_999, &mut p);
    assert!(!file.exists(), "not written before a minute");
    d.tick(NOW + 60_000, 60_000, &mut p);
    assert!(file.exists(), "written once a minute has passed");
}

#[test]
fn shutdown_flush_writes_pending_sessions() {
    let (s, u) = paths("st-shutdown");
    let file = s.parent().unwrap().join("sessions-2023-11-14.json");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for m in 0..=3 {
        call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
    }
    assert!(!file.exists());
    d.flush_usage();
    assert!(file.exists());
}

#[test]
fn clean_non_today_day_is_not_retained_after_reading() {
    let (s, u) = paths("st-evict");
    let dir = s.parent().unwrap();
    let old = focus_helper::sessions::DayStretches {
        truncated: false,
        stretches: vec![focus_helper::sessions::Stretch { start: 1, end: 5, exe: "a.exe".into(), site: None }],
    };
    focus_helper::sessions::save_day(dir, "2023-11-01", &old).unwrap();
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    let r = sessions(&mut d, &mut p, "2023-11-01");
    assert_eq!(r["stretches"].as_array().unwrap().len(), 1);
    assert_eq!(d.loaded_day_count(), 0, "reading does not retain");
    for m in 0..=3 {
        call(&mut d, &mut p, &report("a.exe", None, 0), m * 1000);
    }
    assert_eq!(d.loaded_day_count(), 1, "today is resident");
    d.flush_usage();
    assert_eq!(d.loaded_day_count(), 1, "today stays after the flush");
    call(&mut d, &mut p, &report("a.exe", None, 0).replace("2023-11-14", "2023-11-15"), 5_000);
    call(&mut d, &mut p, &report("a.exe", None, 0).replace("2023-11-14", "2023-11-15"), 6_000);
    d.flush_usage();
    assert_eq!(d.loaded_day_count(), 1, "yesterday evicted once clean");
}

// ---- stretches through the daemon (wall and monotonic clocks controlled) ----

const N: i64 = NOW / 1000;

fn rep(exe: &str, day: &str) -> String {
    json!({"type":"ReportForeground","exe":exe,"title":null,"idle_secs":0,"day":day}).to_string()
}

fn callw(d: &mut Daemon, p: &mut Fake, line: &str, wall: i64, mono: i64) -> Value {
    serde_json::from_str(&d.handle_line(line, wall, mono, [0; 16], p)).unwrap()
}

fn stretches(d: &mut Daemon, p: &mut Fake, day: &str) -> Vec<(i64, i64, String)> {
    let line = json!({"type":"GetSessions","day":day}).to_string();
    let v = call(d, p, &line, 0);
    v["stretches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["start"].as_i64().unwrap(), s["end"].as_i64().unwrap(), s["exe"].as_str().unwrap().to_string()))
        .collect()
}

fn run_1s(d: &mut Daemon, p: &mut Fake, exe: &str, from: i64, to: i64) {
    for mono in (from..=to).step_by(1_000) {
        call(d, p, &rep(exe, "2023-11-14"), mono);
    }
}

#[test]
fn a_stall_does_not_invent_time_or_merge() {
    for stall in [30_000, 60_000] {
        let (s, u) = paths(&format!("stall{stall}"));
        let mut d = Daemon::load_with_usage(&s, &u);
        let mut p = Fake;
        run_1s(&mut d, &mut p, "a.exe", 0, 3_000);
        call(&mut d, &mut p, &rep("a.exe", "2023-11-14"), 3_000 + stall);
        let st = stretches(&mut d, &mut p, "2023-11-14");
        assert_eq!(st.len(), 2, "stall {stall}: {st:?}");
        assert_eq!(st[0], (N, N + 3, "a.exe".into()));
        assert!(st[1].1 - st[1].0 <= 15, "{st:?}");
        assert!(st[1].0 > st[0].1);
    }
}

#[test]
fn a_lock_gap_splits_the_stretch() {
    let (s, u) = paths("lockgap");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    run_1s(&mut d, &mut p, "a.exe", 0, 3_000);
    run_1s(&mut d, &mut p, "a.exe", 23_000, 26_000);
    let st = stretches(&mut d, &mut p, "2023-11-14");
    assert_eq!(st.len(), 2, "{st:?}");
    assert_eq!(st[0], (N, N + 3, "a.exe".into()));
}

#[test]
fn a_stretch_over_midnight_lands_in_both_day_files() {
    let (s, u) = paths("midnight");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for mono in [0, 1_000, 2_000, 3_000] {
        call(&mut d, &mut p, &rep("a.exe", "2023-11-14"), mono);
    }
    for mono in [4_000, 5_000, 6_000] {
        call(&mut d, &mut p, &rep("a.exe", "2023-11-15"), mono);
    }
    assert_eq!(stretches(&mut d, &mut p, "2023-11-14"), vec![(N, N + 3, "a.exe".into())]);
    assert_eq!(stretches(&mut d, &mut p, "2023-11-15"), vec![(N + 3, N + 6, "a.exe".into())]);
}

#[test]
fn wall_clock_going_backwards_never_overlaps() {
    let (s, u) = paths("wallback");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for mono in [0, 1_000, 2_000, 3_000, 4_000, 5_000] {
        callw(&mut d, &mut p, &rep("a.exe", "2023-11-14"), NOW + mono, mono);
    }
    // The wall clock steps back 60 s, then runs on normally.
    for mono in (6_000..=75_000).step_by(1_000) {
        let exe = if mono % 20_000 < 10_000 { "a.exe" } else { "b.exe" };
        callw(&mut d, &mut p, &rep(exe, "2023-11-14"), NOW + mono - 60_000, mono);
    }
    let st = stretches(&mut d, &mut p, "2023-11-14");
    assert!(!st.is_empty());
    for w in st.windows(2) {
        assert!(w[0].1 <= w[1].0, "overlap: {st:?}");
    }
    for s in &st {
        assert!(s.0 < s.1, "empty or negative: {st:?}");
    }
}

#[test]
fn old_five_second_sampler_still_merges() {
    let (s, u) = paths("old5");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    for mono in (0..=30_000).step_by(5_000) {
        call(&mut d, &mut p, &rep("a.exe", "2023-11-14"), mono);
    }
    assert_eq!(stretches(&mut d, &mut p, "2023-11-14"), vec![(N, N + 30, "a.exe".into())]);
}

// ---- stretch file problems reach Status ----

fn warnings(d: &mut Daemon, p: &mut Fake) -> Vec<String> {
    let v = call(d, p, r#"{"type":"GetStatus"}"#, 0);
    v["warnings"].as_array().unwrap().iter().map(|w| w.as_str().unwrap().to_string()).collect()
}

fn dir_names(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()
}

#[test]
fn corrupt_stretch_file_is_quarantined_and_reported() {
    let (s, u) = paths("corruptsess");
    let dir = s.parent().unwrap().to_path_buf();
    std::fs::write(dir.join("sessions-2023-11-14.json"), b"garbage").unwrap();
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    assert!(stretches(&mut d, &mut p, "2023-11-14").is_empty());
    let w = warnings(&mut d, &mut p);
    assert!(w.iter().any(|m| m.starts_with("sessions: 2023-11-14 unreadable, kept as ")), "{w:?}");
    let names = dir_names(&dir);
    assert!(!names.contains(&"sessions-2023-11-14.json".to_string()), "{names:?}");
    assert!(names.iter().any(|n| n.starts_with("sessions-2023-11-14.json.corrupt-")), "{names:?}");
}

#[test]
fn stretch_file_recovered_from_backup_is_reported() {
    use focus_helper::sessions::{save_day, DayStretches, Stretch};
    let (s, u) = paths("baksess");
    let dir = s.parent().unwrap().to_path_buf();
    let mk = |end| DayStretches { truncated: false, stretches: vec![Stretch { start: 1, end, exe: "a.exe".into(), site: None }] };
    save_day(&dir, "2023-11-14", &mk(5)).unwrap();
    save_day(&dir, "2023-11-14", &mk(9)).unwrap();
    std::fs::write(dir.join("sessions-2023-11-14.json"), b"garbage").unwrap();
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    assert_eq!(stretches(&mut d, &mut p, "2023-11-14"), vec![(1, 5, "a.exe".into())]);
    let w = warnings(&mut d, &mut p);
    assert!(w.iter().any(|m| m.starts_with("sessions: 2023-11-14 loaded from backup")), "{w:?}");
}

#[test]
fn a_transient_read_error_does_not_quarantine() {
    let (s, u) = paths("readerr");
    let dir = s.parent().unwrap().to_path_buf();
    // A directory in place of the file: reading it fails with an error other than "not found".
    std::fs::create_dir(dir.join("sessions-2023-11-14.json")).unwrap();
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake;
    assert!(stretches(&mut d, &mut p, "2023-11-14").is_empty());
    let names = dir_names(&dir);
    assert!(names.contains(&"sessions-2023-11-14.json".to_string()), "{names:?}");
    assert!(!names.iter().any(|n| n.contains("corrupt")), "{names:?}");
}
