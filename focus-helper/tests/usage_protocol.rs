use std::io;
use std::path::PathBuf;

use focus_helper::daemon::{Daemon, Platform};
use focus_helper::enforce::{Proc, ProcessTable};
use focus_helper::usage::{DayUsage, Sample};
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
struct Fake {
    tracking: bool,
    sample: Option<Sample>,
    calls: usize,
}

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
    fn foreground(&mut self) -> Option<Sample> {
        self.calls += 1;
        self.sample.clone()
    }
    fn usage_tracking(&self) -> bool {
        self.tracking
    }
}

fn paths(name: &str) -> (PathBuf, PathBuf) {
    let d = std::env::temp_dir().join(format!("focus-usage-proto-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    (d.join("state.json"), d.join("usage.json"))
}

fn chrome(title: &str) -> Sample {
    Sample { exe: "chrome.exe".into(), title: Some(title.into()), idle_secs: 0, day: "2026-11-11".into() }
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
    let mut off = Fake::default();
    assert_eq!(call(&mut d, &mut off, r#"{"type":"GetStatus"}"#, 0)["usage_tracking"], false);
    let mut on = Fake { tracking: true, ..Fake::default() };
    assert_eq!(call(&mut d, &mut on, r#"{"type":"GetStatus"}"#, 0)["usage_tracking"], true);
}

#[test]
fn sampling_every_five_seconds() {
    let (s, u) = paths("every5");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake { tracking: true, sample: Some(chrome("Inbox")), ..Fake::default() };
    for mono in [0, 1_000, 5_000, 10_000] {
        d.tick(NOW + mono, mono, &mut p);
    }
    let r = usage(&mut d, &mut p);
    assert_eq!(r["days"][0]["total"], 10);
    assert_eq!(r["days"][0]["apps"]["chrome.exe"], 10);
}

#[test]
fn untracked_platform_is_not_sampled() {
    let (s, u) = paths("untracked");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake { tracking: false, sample: Some(chrome("Inbox")), ..Fake::default() };
    for mono in [0, 5_000, 10_000] {
        d.tick(NOW + mono, mono, &mut p);
    }
    assert_eq!(p.calls, 0);
    assert_eq!(usage(&mut d, &mut p)["days"], json!([]));
}

#[test]
fn suspend_gap_capped() {
    let (s, u) = paths("gap");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake { tracking: true, sample: Some(chrome("Inbox")), ..Fake::default() };
    d.tick(NOW, 0, &mut p);
    d.tick(NOW + 600_000, 600_000, &mut p);
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 15);
}

#[test]
fn block_list_stem_used() {
    let (s, u) = paths("stem");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake { tracking: true, sample: Some(chrome("Inbox | acmecorp")), ..Fake::default() };
    let w = json!({"id":"w","starts":NOW-1000,"ends":NOW+3_600_000,"lock":"none","mode":"block","sites":["acmecorp.com"],"apps":[]});
    let r = call(&mut d, &mut p, &json!({"type":"PushWindows","windows":[w]}).to_string(), 0);
    assert_eq!(r["type"], "Ok");
    d.tick(NOW, 0, &mut p);
    d.tick(NOW + 5_000, 5_000, &mut p);
    let r = usage(&mut d, &mut p);
    assert_eq!(r["days"][0]["sites"]["acmecorp"], 5);
}

#[test]
fn get_usage_shape() {
    let (s, u) = paths("shape");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake::default();
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
    let mut p = Fake::default();
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
        let mut p = Fake { tracking: true, sample: Some(chrome("Inbox")), ..Fake::default() };
        d.tick(NOW, 0, &mut p);
        d.tick(NOW + 5_000, 5_000, &mut p);
        assert!(!u.exists(), "not saved before the minute is up");
        d.flush_usage();
    }
    assert!(u.exists());
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake::default();
    assert_eq!(usage(&mut d, &mut p)["days"][0]["total"], 5);
}

#[test]
fn usage_saved_once_a_minute_when_dirty() {
    let (s, u) = paths("minute");
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake { tracking: true, sample: Some(chrome("Inbox")), ..Fake::default() };
    for mono in (0..=60_000).step_by(5_000) {
        d.tick(NOW + mono, mono, &mut p);
    }
    assert!(u.exists());
}

#[test]
fn unreadable_usage_file_warns_without_titles() {
    let (s, u) = paths("corrupt");
    std::fs::write(&u, b"garbage").unwrap();
    let mut d = Daemon::load_with_usage(&s, &u);
    let mut p = Fake::default();
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
