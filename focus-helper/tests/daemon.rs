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
    Window { id: id.into(), starts, ends, lock, mode: Mode::Block, sites: vec!["x.com".into(), "a.com".into()], apps: vec![], app_folders: vec![], unlock_delay_ms: if lock == Lock::Locked { Some(86_400_000) } else { None } }
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
    assert_eq!(p.hosts.last().unwrap().len(), 2);
    d.tick(NOW + 30_000, 30_000, &mut p);
    let after_push = p.hosts.len();
    // Wall clock jumps back 10 minutes; only 10 s of monotonic time pass.
    d.tick(NOW - 600_000, 40_000, &mut p);
    // The 30 s drift re-apply may run (monotonic time passed) but the block is never lifted.
    assert!(p.hosts.len() >= after_push);
    assert!(p.hosts[1..].iter().all(|h| h.len() == 2), "block never lifted: {:?}", p.hosts);
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
    // a valid permit so only the lock decides here
    let mut s = persist::load(&path);
    s.uninstall_permit = Some(focus_helper::lockstore::UninstallPermit { granted_at: NOW, expires_at: NOW + 3_600_000 });
    persist::save(&path, &s).unwrap();
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

fn vector(name: &str) -> Value {
    serde_json::from_str::<Vec<Value>>(
        &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/unlock-vectors.json")).unwrap(),
    )
    .unwrap()
    .into_iter()
    .find(|v| v["name"] == name)
    .unwrap()
}

fn send(d: &mut Daemon, p: &mut Fake, req: Value, wall: i64, mono: i64, nonce: [u8; 16]) -> Value {
    serde_json::from_str(&d.handle_line(&req.to_string(), wall, mono, nonce, p)).unwrap()
}

#[test]
fn set_partner_persists_immediately() {
    let path = tmp("setpartner");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let key = vector("valid")["publicKey"].as_str().unwrap().to_string();
    let out = send(&mut d, &mut p, json!({"type":"SetPartner","public_key":key}), NOW, 0, [0; 16]);
    assert_eq!(out["type"], "Ok");
    assert_eq!(persist::load(&path).partner_key.as_deref(), Some(key.as_str()));
}

#[test]
fn submit_token_persists_and_applies_immediately() {
    let path = tmp("submit");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let key = vector("valid")["publicKey"].as_str().unwrap().to_string();
    send(&mut d, &mut p, json!({"type":"SetPartner","public_key":key}), NOW, 0, [0; 16]);
    let w = window("win-1", Lock::Locked, NOW - 1000, NOW + 60_000);
    assert_eq!(send(&mut d, &mut p, json!({"type":"PushWindows","windows":[w.clone()]}), NOW, 1, [0; 16])["type"], "Ok");
    assert_eq!(p.hosts.last().unwrap().len(), 2);
    let nonce: [u8; 16] = core::array::from_fn(|i| i as u8);
    assert_eq!(send(&mut d, &mut p, json!({"type":"RequestChallenge","window_id":"win-1"}), NOW, 2, nonce)["type"], "Challenge");
    let token = vector("valid")["token"].as_str().unwrap().to_string();
    let out = send(&mut d, &mut p, json!({"type":"SubmitToken","token":token}), NOW, 3, [0; 16]);
    assert_eq!(out["type"], "Ok", "{out}");
    // saved to disk now, with the tombstone, and the block lifted without waiting for a tick
    let loaded = persist::load(&path);
    assert!(loaded.windows.iter().all(|x| x.ends <= NOW + 1000));
    assert_eq!(loaded.ended_early.len(), 1);
    assert!(p.hosts.last().unwrap().is_empty());
    // the app's next re-push does not bring the lock back
    send(&mut d, &mut p, json!({"type":"PushWindows","windows":[w]}), NOW + 5000, 5000, [0; 16]);
    let st = status(&mut d, &mut p, NOW + 5000, 5001);
    assert_eq!(st["decision"]["locks"], json!([]));
    assert!(p.hosts.last().unwrap().is_empty());
}

#[test]
fn hosts_are_reapplied_every_30s_while_sites_are_active() {
    let path = tmp("drift");
    seed(&path, vec![window("w", Lock::None, NOW - 1000, NOW + 200_000)], 0);
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    d.tick(NOW, 0, &mut p);
    assert_eq!(p.hosts.len(), 1);
    d.tick(NOW + 29_000, 29_000, &mut p);
    assert_eq!(p.hosts.len(), 1, "not before 30 s");
    d.tick(NOW + 30_000, 30_000, &mut p);
    assert_eq!(p.hosts.len(), 2, "re-applied after 30 s");
    assert_eq!(p.hosts[1], vec!["a.com".to_string(), "x.com".to_string()]);
    d.tick(NOW + 59_000, 59_000, &mut p);
    assert_eq!(p.hosts.len(), 2);
    d.tick(NOW + 60_000, 60_000, &mut p);
    assert_eq!(p.hosts.len(), 3);
}

#[test]
fn no_hosts_reapply_when_no_sites_active() {
    let path = tmp("drift-idle");
    seed(&path, vec![window("w", Lock::None, NOW + 500_000, NOW + 600_000)], 0);
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    d.tick(NOW, 0, &mut p);
    let n = p.hosts.len(); // the initial empty apply
    for i in 1..=4 {
        d.tick(NOW + i * 31_000, i * 31_000, &mut p);
    }
    assert_eq!(p.hosts.len(), n, "idle daemon never touches the hosts file again");
}

#[test]
fn reset_clock_refused_with_pending_lock_allowed_otherwise() {
    let path = tmp("resetclock");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let key = vector("valid")["publicKey"].as_str().unwrap().to_string();
    send(&mut d, &mut p, json!({"type":"SetPartner","public_key":key}), NOW, 0, [0; 16]);
    // a pending (future) lock refuses the reset
    let w = window("later", Lock::Locked, NOW + 10_000, NOW + 60_000);
    send(&mut d, &mut p, json!({"type":"PushWindows","windows":[w]}), NOW, 1, [0; 16]);
    let out = send(&mut d, &mut p, json!({"type":"ResetClock"}), NOW, 2, [0; 16]);
    assert_eq!((out["type"].as_str(), out["code"].as_str()), (Some("Error"), Some("lock-active")));
    // wall clock far in the future was persisted; once the lock is gone, reset recovers
    let mut d2 = Daemon::load(&tmp("resetclock2"));
    let far = NOW + 400 * 86_400_000;
    assert_eq!(status(&mut d2, &mut p, far, 0)["now_ms"], far);
    assert_eq!(status(&mut d2, &mut p, NOW, 1000)["now_ms"], far + 1000);
    assert_eq!(send(&mut d2, &mut p, json!({"type":"ResetClock"}), NOW, 2000, [0; 16])["type"], "Ok");
    assert_eq!(status(&mut d2, &mut p, NOW, 2000)["now_ms"], NOW);
    assert_eq!(persist::load(&tmp_same("resetclock2")).high_water_ms, NOW);
}

fn tmp_same(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("focus-daemon-{}-{name}", std::process::id())).join("state.json")
}

#[test]
fn tick_expires_pending_and_saves() {
    use focus_helper::lockstore::PendingUnlock;
    let path = tmp("expire");
    let day = 86_400_000;
    let mut w = window("w", Lock::Locked, NOW - 10, NOW + 2 * day);
    w.unlock_delay_ms = Some(day);
    let store = LockStore {
        windows: vec![w],
        partner_key: Some("k".into()),
        high_water_ms: NOW,
        pending_unlocks: vec![PendingUnlock { window_id: "w".into(), unlock_at: NOW + 1000 }],
        ..LockStore::default()
    };
    persist::save(&path, &store).unwrap();
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    d.tick(NOW, 0, &mut p);
    assert_eq!(d.store().pending_unlocks.len(), 1);
    d.tick(NOW + 2000, 2000, &mut p);
    assert!(d.store().pending_unlocks.is_empty());
    let loaded = persist::load(&path);
    assert!(loaded.pending_unlocks.is_empty());
    assert!(loaded.windows[0].ends <= NOW + 2000);
    assert_eq!(loaded.ended_early.len(), 1);
    // enforcement is lifted
    assert_eq!(p.hosts.last(), Some(&Vec::<String>::new()));
}

// ---- uninstall protection ----

const DAY: i64 = 86_400_000;

#[test]
fn uninstall_requests_persist_at_once() {
    let path = tmp("un-persist");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let out = send(&mut d, &mut p, json!({"type":"RequestUninstallDelay"}), NOW, 0, [0; 16]);
    assert_eq!(out, json!({"type":"UninstallPending","unlock_at":NOW + DAY}));
    assert_eq!(persist::load(&path).uninstall_pending.unwrap().unlock_at, NOW + DAY);
    assert_eq!(send(&mut d, &mut p, json!({"type":"CancelUninstallDelay"}), NOW, 0, [0; 16])["type"], "Ok");
    assert!(persist::load(&path).uninstall_pending.is_none());
    let e = send(&mut d, &mut p, json!({"type":"CancelUninstallDelay"}), NOW, 0, [0; 16]);
    assert_eq!(e["code"], "no-pending-uninstall");
    assert_eq!(send(&mut d, &mut p, json!({"type":"SetUninstallWait","wait_ms":2 * DAY}), NOW, 0, [0; 16])["type"], "Ok");
    assert_eq!(persist::load(&path).uninstall_wait_ms, 2 * DAY);
    assert_eq!(send(&mut d, &mut p, json!({"type":"SetUninstallWait","wait_ms":DAY}), NOW, 0, [0; 16])["code"], "needs-permit");
    assert_eq!(send(&mut d, &mut p, json!({"type":"SetUninstallWait","wait_ms":1}), NOW, 0, [0; 16])["code"], "bad-request");
}

#[test]
fn status_reports_uninstall_and_wait_becomes_permit_without_a_tick() {
    let path = tmp("un-status");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let st = status(&mut d, &mut p, NOW, 0);
    assert_eq!(st["uninstall"], json!({"wait_ms":DAY,"pending_at":null,"permit_until":null,"partner_ready_at":null}));
    send(&mut d, &mut p, json!({"type":"RequestUninstallDelay"}), NOW, 0, [0; 16]);
    let st = status(&mut d, &mut p, NOW + 1000, 1000);
    assert_eq!(st["uninstall"], json!({"wait_ms":DAY,"pending_at":NOW + DAY,"permit_until":null,"partner_ready_at":null}));
    assert!(!d.stop_allowed(NOW + 1000, 1000));
    // due: no tick in between, GetStatus converts it and saves the state file
    let st = status(&mut d, &mut p, NOW + DAY + 10, DAY + 10);
    assert_eq!(st["uninstall"], json!({"wait_ms":DAY,"pending_at":null,"permit_until":NOW + DAY + 3_600_000,"partner_ready_at":null}));
    let saved = persist::load(&path);
    assert!(saved.uninstall_pending.is_none());
    assert_eq!(saved.uninstall_permit.unwrap().expires_at, NOW + DAY + 3_600_000);
    // permit window passes: dropped again
    let st = status(&mut d, &mut p, NOW + DAY + 3_600_001, DAY + 3_600_001);
    assert_eq!(st["uninstall"]["permit_until"], Value::Null);
    assert!(persist::load(&path).uninstall_permit.is_none());
}

#[test]
fn stop_allowed_flips_with_the_permit_and_converts_due_wait() {
    let path = tmp("un-stop");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    assert!(!d.stop_allowed(NOW, 0), "no permit, no lock: still refused");
    send(&mut d, &mut p, json!({"type":"RequestUninstallDelay"}), NOW, 0, [0; 16]);
    assert!(!d.stop_allowed(NOW + DAY - 1, DAY - 1));
    // due wait is converted by stop_allowed itself and saved
    assert!(d.stop_allowed(NOW + DAY + 1, DAY + 1));
    assert!(persist::load(&path).uninstall_permit.is_some());
    assert!(d.stop_allowed(NOW + DAY + 3_599_000, DAY + 3_599_000));
    assert!(!d.stop_allowed(NOW + DAY + 3_600_001, DAY + 3_600_001));
    assert!(persist::load(&path).uninstall_permit.is_none());
}

#[test]
fn permit_does_not_override_a_pending_lock() {
    let path = tmp("un-stop-lock");
    let store = LockStore {
        windows: vec![window("w", Lock::Locked, NOW - 1000, NOW + 5000)],
        high_water_ms: NOW,
        uninstall_permit: Some(focus_helper::lockstore::UninstallPermit { granted_at: NOW, expires_at: NOW + 1_800_000 }),
        ..LockStore::default()
    };
    persist::save(&path, &store).unwrap();
    let mut d = Daemon::load(&path);
    assert!(!d.stop_allowed(NOW, 0));
    assert!(d.stop_allowed(NOW + 6000, 6000));
}

#[test]
fn tick_turns_due_wait_into_permit_and_saves() {
    let path = tmp("un-tick");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    send(&mut d, &mut p, json!({"type":"RequestUninstallDelay"}), NOW, 0, [0; 16]);
    d.tick(NOW + DAY + 1, DAY + 1, &mut p);
    assert_eq!(d.store().uninstall_permit.unwrap().expires_at, NOW + DAY + 3_600_000);
    assert_eq!(persist::load(&path).uninstall_permit.unwrap().expires_at, NOW + DAY + 3_600_000);
}

#[test]
fn restart_keeps_pending_and_permit() {
    let path = tmp("un-restart");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    send(&mut d, &mut p, json!({"type":"RequestUninstallDelay"}), NOW, 0, [0; 16]);
    let mut d2 = Daemon::load(&path);
    let st = status(&mut d2, &mut p, NOW + 5, 5);
    assert_eq!(st["uninstall"]["pending_at"], NOW + DAY);
    // wall clock set back after restart does not shorten the wait
    let st = status(&mut d2, &mut p, NOW - 3 * DAY, 10);
    assert_eq!(st["uninstall"]["pending_at"], NOW + DAY);
    status(&mut d2, &mut p, NOW + DAY + 1, 20);
    let mut d3 = Daemon::load(&path);
    let st = status(&mut d3, &mut p, NOW + DAY + 2, 0);
    assert_eq!(st["uninstall"]["permit_until"], NOW + DAY + 3_600_000);
}

fn uninstall_token(d: &mut Daemon, p: &mut Fake, wall: i64, nonce: [u8; 16], sk: &p256::ecdsa::SigningKey, exp: i64) -> (Value, String) {
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::Signature;
    let b64 = |b: &[u8]| focus_helper::unlock::b64u_encode(b);
    let ch = send(d, p, json!({"type":"RequestChallenge","window_id":"uninstall"}), wall, wall - NOW, nonce);
    assert_eq!(ch["type"], "Challenge", "{ch}");
    let cv: Value = serde_json::from_slice(&focus_helper::unlock::b64u_decode(ch["code"].as_str().unwrap()).unwrap()).unwrap();
    let payload = format!(r#"{{"n":"{}","w":"uninstall","exp":{}}}"#, cv["n"].as_str().unwrap(), exp);
    let sig: Signature = sk.sign(payload.as_bytes());
    (ch, format!("{}.{}", b64(payload.as_bytes()), b64(&sig.to_bytes())))
}

fn partner_daemon(name: &str) -> (Daemon, Fake, p256::ecdsa::SigningKey, PathBuf) {
    let path = tmp(name);
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let sk = p256::ecdsa::SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
    let pk = focus_helper::unlock::b64u_encode(sk.verifying_key().to_encoded_point(false).as_bytes());
    assert_eq!(send(&mut d, &mut p, json!({"type":"SetPartner","public_key":pk}), NOW, 0, [0; 16])["type"], "Ok");
    (d, p, sk, path)
}

#[test]
fn partner_token_grants_permit_through_the_daemon() {
    let (mut d, mut p, sk, path) = partner_daemon("un-token");
    // the partner key is new: one waiting period must pass first
    let at = NOW + DAY;
    send(&mut d, &mut p, json!({"type":"RequestUninstallDelay"}), at, DAY, [0; 16]);
    let (_, token) = uninstall_token(&mut d, &mut p, at, [5; 16], &sk, at + 600_000);
    assert!(!d.stop_allowed(at, DAY));
    let out = send(&mut d, &mut p, json!({"type":"SubmitToken","token":token.clone()}), at, DAY, [0; 16]);
    assert_eq!(out["type"], "Ok", "{out}");
    let saved = persist::load(&path);
    assert_eq!(saved.uninstall_permit.unwrap().expires_at, at + 1_800_000);
    assert!(saved.uninstall_pending.is_none());
    assert!(d.stop_allowed(at + 1000, DAY + 1000));
    let st = status(&mut d, &mut p, at + 1000, DAY + 1000);
    assert_eq!(st["uninstall"]["permit_until"], at + 1_800_000);
    assert_eq!(send(&mut d, &mut p, json!({"type":"SubmitToken","token":token}), at, DAY, [0; 16])["code"], "used");
    assert!(!d.stop_allowed(at + 1_800_000, DAY + 1_800_000));
}

#[test]
fn new_partner_key_cannot_approve_uninstall_until_one_wait_passed() {
    let (mut d, mut p, sk, path) = partner_daemon("un-new-partner");
    let st = status(&mut d, &mut p, NOW, 0);
    assert_eq!(st["uninstall"]["partner_ready_at"], NOW + DAY);
    let (_, token) = uninstall_token(&mut d, &mut p, NOW, [5; 16], &sk, NOW + 600_000);
    let out = send(&mut d, &mut p, json!({"type":"SubmitToken","token":token.clone()}), NOW, 0, [0; 16]);
    assert_eq!((out["type"].as_str(), out["code"].as_str()), (Some("Error"), Some("partner-too-new")), "{out}");
    let saved = persist::load(&path);
    assert!(saved.uninstall_permit.is_none(), "no permit");
    assert!(saved.challenges.iter().all(|c| !c.used), "token not consumed");
    assert!(!d.stop_allowed(NOW, 0));
    // swapping to another key restarts the clock
    let sk2 = p256::ecdsa::SigningKey::from_bytes(&[7u8; 32].into()).unwrap();
    let pk2 = focus_helper::unlock::b64u_encode(sk2.verifying_key().to_encoded_point(false).as_bytes());
    let at = NOW + DAY;
    send(&mut d, &mut p, json!({"type":"SetPartner","public_key":pk2}), at, DAY, [0; 16]);
    assert_eq!(status(&mut d, &mut p, at, DAY)["uninstall"]["partner_ready_at"], at + DAY);
    let (_, t2) = uninstall_token(&mut d, &mut p, at, [6; 16], &sk2, at + 600_000);
    let out = send(&mut d, &mut p, json!({"type":"SubmitToken","token":t2}), at, DAY, [0; 16]);
    assert_eq!(out["code"], "partner-too-new", "{out}");
    // one more wait on: works and grants exactly 30 minutes
    let later = at + DAY;
    let (_, t3) = uninstall_token(&mut d, &mut p, later, [7; 16], &sk2, later + 600_000);
    let out = send(&mut d, &mut p, json!({"type":"SubmitToken","token":t3}), later, 2 * DAY, [0; 16]);
    assert_eq!(out["type"], "Ok", "{out}");
    assert_eq!(persist::load(&path).uninstall_permit.unwrap().expires_at, later + 1_800_000);
    assert_eq!(status(&mut d, &mut p, later, 2 * DAY)["uninstall"]["partner_ready_at"], Value::Null);
}

#[test]
fn uninstall_challenge_obeys_the_same_ttl() {
    let path = tmp("un-ttl");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    let sk = p256::ecdsa::SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
    let pk = focus_helper::unlock::b64u_encode(sk.verifying_key().to_encoded_point(false).as_bytes());
    send(&mut d, &mut p, json!({"type":"SetPartner","public_key":pk}), NOW, 0, [0; 16]);
    let later = NOW + 3_700_000;
    let (_, token) = uninstall_token(&mut d, &mut p, NOW, [6; 16], &sk, later + 600_000);
    let out = send(&mut d, &mut p, json!({"type":"SubmitToken","token":token}), later, 3_700_000, [0; 16]);
    assert_eq!(out["code"], "challenge-expired", "{out}");
    assert!(persist::load(&path).uninstall_permit.is_none());
}

#[test]
fn reset_clock_refused_while_an_uninstall_wait_or_permit_exists() {
    let path = tmp("un-interplay");
    let mut d = Daemon::load(&path);
    let mut p = Fake::default();
    send(&mut d, &mut p, json!({"type":"RequestUninstallDelay"}), NOW, 0, [0; 16]);
    assert_eq!(send(&mut d, &mut p, json!({"type":"ResetClock"}), NOW, 0, [0; 16])["code"], "lock-active");
    assert_eq!(status(&mut d, &mut p, NOW, 2)["uninstall"]["pending_at"], NOW + DAY);
    // the wait is over: a permit exists, still refused
    assert_eq!(send(&mut d, &mut p, json!({"type":"ResetClock"}), NOW + DAY + 5, 5, [0; 16])["code"], "lock-active");
    // cancelled wait and no permit: allowed
    let mut d2 = Daemon::load(&tmp("un-interplay2"));
    send(&mut d2, &mut p, json!({"type":"RequestUninstallDelay"}), NOW, 0, [0; 16]);
    send(&mut d2, &mut p, json!({"type":"CancelUninstallDelay"}), NOW, 1, [0; 16]);
    assert_eq!(send(&mut d2, &mut p, json!({"type":"ResetClock"}), NOW, 2, [0; 16])["type"], "Ok");
}
