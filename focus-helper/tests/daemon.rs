use std::io;
use std::path::PathBuf;

use focus_helper::daemon::Daemon;
use focus_helper::daemon::Platform;
use focus_helper::enforce::{Proc, ProcessTable};
use focus_helper::lockstore::LockStore;
use focus_helper::model::{Lock, Mode, Window};
use focus_helper::persist;
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
    hosts: Vec<Vec<String>>,
    doh_off: usize,
    doh_clear: usize,
    flushes: usize,
    fail_hosts: bool,
    doh_warnings: Vec<String>,
}

impl Platform for Fake {
    fn enforce_hosts(&mut self, sites: &[String]) -> io::Result<bool> {
        self.hosts.push(sites.to_vec());
        if self.fail_hosts {
            Err(io::Error::other("acl boom"))
        } else {
            Ok(true)
        }
    }
    fn set_doh_off(&mut self) -> io::Result<Vec<String>> {
        self.doh_off += 1;
        Ok(self.doh_warnings.clone())
    }
    fn clear_doh_off(&mut self) -> io::Result<()> {
        self.doh_clear += 1;
        Ok(())
    }
    fn flush_dns(&mut self) -> io::Result<()> {
        self.flushes += 1;
        Ok(())
    }
    fn process_table(&self) -> &dyn ProcessTable {
        &Empty
    }
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("focus-daemon-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.join("state.json")
}

fn window(id: &str, lock: Lock, starts: i64, ends: i64) -> Window {
    Window { id: id.into(), starts, ends, lock, mode: Mode::Block, sites: vec!["x.com".into(), "a.com".into()], apps: vec![] }
}

fn seed(path: &PathBuf, windows: Vec<Window>, high_water: i64) {
    let store = LockStore { windows, high_water_ms: high_water, ..LockStore::default() };
    persist::save(path, &store).unwrap();
}

fn status(d: &mut Daemon, p: &mut Fake, wall: i64, mono: i64) -> Value {
    serde_json::from_str(&d.handle_line(r#"{"type":"GetStatus"}"#, wall, mono, [0; 16], p)).unwrap()
}

#[test]
fn hosts_applied_once_then_removed_when_window_ends() {
    let path = tmp("hosts");
    seed(&path, vec![window("w", Lock::None, NOW - 1000, NOW + 5000)], 0);
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    d.tick(NOW, 0, &mut p);
    d.tick(NOW + 1000, 1000, &mut p);
    assert_eq!(p.hosts, vec![vec!["a.com".to_string(), "x.com".to_string()]]);
    assert_eq!(p.flushes, 1);
    assert_eq!(p.doh_off, 1);
    d.tick(NOW + 6000, 6000, &mut p);
    assert_eq!(p.hosts.len(), 2);
    assert!(p.hosts[1].is_empty());
    assert_eq!(p.flushes, 2);
    assert_eq!(p.doh_clear, 1);
}

#[test]
fn doh_warnings_reach_status() {
    let path = tmp("doh");
    seed(&path, vec![window("w", Lock::None, NOW - 1000, NOW + 5000)], 0);
    let mut d = Daemon::load(&path);
    let mut p = Fake { doh_warnings: vec!["firefox: managed".into()], ..Fake::default() };
    d.tick(NOW, 0, &mut p);
    let st = status(&mut d, &mut p, NOW, 10);
    assert_eq!(st["warnings"], json!(["firefox: managed"]));
}

#[test]
fn status_warnings_always_array() {
    let path = tmp("nowarn");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let st = status(&mut d, &mut p, NOW, 0);
    assert_eq!(st["warnings"], json!([]));
}

#[test]
fn platform_error_is_retried_and_flush_still_happens() {
    let path = tmp("err");
    seed(&path, vec![window("w", Lock::None, NOW - 1000, NOW + 50_000)], 0);
    let mut d = Daemon::load(&path);
    let mut p = Fake { fail_hosts: true, ..Fake::default() };
    d.tick(NOW, 0, &mut p);
    assert_eq!(p.hosts.len(), 1);
    assert_eq!(p.flushes, 1);
    let st = status(&mut d, &mut p, NOW, 1);
    assert!(st["warnings"][0].as_str().unwrap().starts_with("hosts: "));
    d.tick(NOW + 1000, 1000, &mut p);
    assert_eq!(p.hosts.len(), 2, "retried next tick");
    assert_eq!(p.flushes, 2);
    p.fail_hosts = false;
    d.tick(NOW + 2000, 2000, &mut p);
    d.tick(NOW + 3000, 3000, &mut p);
    assert_eq!(p.hosts.len(), 3, "no retry after success");
    let st = status(&mut d, &mut p, NOW + 3000, 3000);
    assert_eq!(st["warnings"], json!([]));
}

#[test]
fn clock_rollback_does_not_end_locked_window() {
    let path = tmp("rollback");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let key = serde_json::from_str::<Vec<Value>>(
        &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/unlock-vectors.json")).unwrap(),
    )
    .unwrap()
    .into_iter()
    .find(|v| v["name"] == "valid")
    .unwrap()["publicKey"]
        .as_str()
        .unwrap()
        .to_string();
    d.handle_line(&json!({"type":"SetPartner","public_key":key}).to_string(), NOW, 0, [0; 16], &mut p);
    let w = window("w", Lock::Locked, NOW - 1000, NOW + 60_000);
    let line = json!({"type":"PushWindows","windows":[w]}).to_string();
    assert!(d.handle_line(&line, NOW, 10, [0; 16], &mut p).contains("\"Ok\""));
    let after_push = p.hosts.len();
    assert_eq!(p.hosts.last().unwrap().len(), 2);
    d.tick(NOW + 30_000, 30_000, &mut p);
    // Wall clock jumps back 10 minutes; only 10 s of monotonic time pass.
    d.tick(NOW - 600_000, 40_000, &mut p);
    assert_eq!(p.hosts.len(), after_push, "block neither lifted nor reapplied");
    // Wall clock forward past the end but effective time must still count monotonic only: still active.
    let st = status(&mut d, &mut p, NOW - 600_000, 41_000);
    assert_eq!(st["decision"]["locks"].as_array().unwrap().len(), 1);
    assert!(st["now_ms"].as_i64().unwrap() >= NOW + 30_000);
}

#[test]
fn load_seeds_clock_from_persisted_high_water() {
    let path = tmp("seed");
    let future = NOW + 600_000;
    seed(&path, vec![window("w", Lock::Locked, NOW, NOW + 900_000)], future);
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    // Wall clock before the window starts; high-water puts effective time inside it.
    d.tick(NOW - 3_600_000, 0, &mut p);
    assert_eq!(p.hosts.len(), 1, "window active because clock is seeded");
    let st = status(&mut d, &mut p, NOW - 3_600_000, 5);
    assert!(st["now_ms"].as_i64().unwrap() >= future);
}

#[test]
fn periodic_persistence_after_30s_effective_time() {
    let path = tmp("periodic");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    d.tick(NOW, 0, &mut p);
    d.tick(NOW + 20_000, 20_000, &mut p);
    assert!(!path.exists());
    d.tick(NOW + 31_000, 31_000, &mut p);
    assert!(path.exists());
    assert_eq!(persist::load(&path).high_water_ms, NOW + 31_000);
}

#[test]
fn mutation_persists_immediately() {
    let path = tmp("mutate");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let out = d.handle_line(&json!({"type":"PushWindows","windows":[window("w", Lock::None, NOW - 10, NOW + 9000)]}).to_string(), NOW, 0, [0; 16], &mut p);
    assert!(out.contains("\"Ok\""));
    let loaded = persist::load(&path);
    assert_eq!(loaded.windows.len(), 1);
    assert_eq!(&loaded, d.store());
    // and the new block is applied without waiting for a tick
    assert_eq!(p.hosts.len(), 1);
}

#[test]
fn persist_failure_is_surfaced_and_retried() {
    let dir = std::env::temp_dir().join(format!("focus-daemon-{}-pfail", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // Parent "directory" is a file, so every save fails deterministically.
    let blocker = dir.join("sub");
    std::fs::write(&blocker, b"x").unwrap();
    let path = blocker.join("state.json");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let line = json!({"type":"PushWindows","windows":[window("w", Lock::None, NOW - 10, NOW + 90_000)]}).to_string();
    let out: Value = serde_json::from_str(&d.handle_line(&line, NOW, 0, [0; 16], &mut p)).unwrap();
    assert_eq!(out["type"], "Error");
    assert_eq!(out["code"], "persist-failed");
    assert!(out["message"].as_str().unwrap().contains("lost on restart"));
    // still enforced in memory
    assert_eq!(p.hosts.last().unwrap().len(), 2);
    d.tick(NOW + 1000, 1000, &mut p); // must not panic
    let st = status(&mut d, &mut p, NOW + 1000, 1001);
    assert!(st["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().starts_with("persist: ")));
    // make it writable again: next tick (well under 30 s) saves and clears the warning
    std::fs::remove_file(&blocker).unwrap();
    std::fs::create_dir(&blocker).unwrap();
    d.tick(NOW + 2000, 2000, &mut p);
    assert_eq!(persist::load(&path).windows.len(), 1);
    let st = status(&mut d, &mut p, NOW + 2000, 2001);
    assert!(!st["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().starts_with("persist: ")));
}

#[test]
fn first_idle_tick_clears_stale_doh_once() {
    let path = tmp("stale-doh");
    seed(&path, vec![], 0);
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    d.tick(NOW, 0, &mut p);
    assert_eq!(p.doh_clear, 1);
    d.tick(NOW + 1000, 1000, &mut p);
    d.tick(NOW + 2000, 2000, &mut p);
    assert_eq!(p.doh_clear, 1, "only once while idle");
    assert_eq!(p.doh_off, 0);
}

#[test]
fn no_startup_clear_when_a_window_is_active_at_start() {
    let path = tmp("active-start");
    seed(&path, vec![window("w", Lock::None, NOW - 1000, NOW + 5000)], 0);
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    d.tick(NOW, 0, &mut p);
    assert_eq!((p.doh_off, p.doh_clear), (1, 0));
}

#[test]
fn stop_allowed_uses_the_effective_clock() {
    let path = tmp("stop-allowed");
    seed(&path, vec![window("w", Lock::Locked, NOW - 1000, NOW + 5000)], NOW);
    let mut d = Daemon::load(&path);
    assert!(!d.stop_allowed(NOW, 0));
    // Wall clock set back an hour: still inside the lock.
    assert!(!d.stop_allowed(NOW - 3_600_000, 1000));
    assert!(d.stop_allowed(NOW + 6000, 7000));
}

#[test]
fn state_loaded_from_backup_warns() {
    let path = tmp("bakwarn");
    seed(&path, vec![], 1);
    seed(&path, vec![window("w", Lock::None, NOW - 1000, NOW + 5000)], 2); // first copy becomes .bak
    std::fs::write(&path, b"{ broken").unwrap();
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    assert_eq!(d.store().high_water_ms, 1);
    let st = status(&mut d, &mut p, NOW, 0);
    assert_eq!(st["warnings"][0], "state: loaded from backup");
}

#[test]
fn unreadable_state_is_kept_and_reported() {
    let path = tmp("corrupt");
    std::fs::write(&path, b"garbage main").unwrap();
    std::fs::write(path.with_file_name("state.json.bak"), b"garbage bak").unwrap();
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let st = status(&mut d, &mut p, NOW, 0);
    let w = st["warnings"][0].as_str().unwrap();
    assert!(w.starts_with("state: unreadable, started empty — previous state kept as "), "{w}");
    // the first save must not overwrite the evidence
    d.handle_line(r#"{"type":"PushWindows","windows":[]}"#, NOW, 1, [0; 16], &mut p);
    d.handle_line(r#"{"type":"PushWindows","windows":[]}"#, NOW, 2, [0; 16], &mut p);
    let dir = path.parent().unwrap();
    let kept: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains(".corrupt-"))
        .collect();
    assert_eq!(kept.len(), 2, "{kept:?}");
    let main = kept.iter().find(|n| n.starts_with("state.json.corrupt-")).unwrap();
    assert_eq!(std::fs::read(dir.join(main)).unwrap(), b"garbage main");
    assert!(persist::load(&path).windows.is_empty());
}
