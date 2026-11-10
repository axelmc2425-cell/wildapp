use focus_helper::decide::CRITICAL_APPS;
use focus_helper::enforce::{enforce_once, Proc, ProcessTable, VPN_APPS};
use focus_helper::model::{Allow, Decision};
use std::cell::RefCell;

struct FakeTable {
    procs: Vec<Proc>,
    killed: RefCell<Vec<u32>>,
    fail: Vec<u32>,
}
impl FakeTable {
    fn with_paths(items: &[(u32, &str, Option<&str>)]) -> Self {
        FakeTable {
            procs: items
                .iter()
                .map(|(p, n, x)| Proc { pid: *p, name: n.to_string(), path: x.map(|s| s.to_string()) })
                .collect(),
            killed: RefCell::new(vec![]),
            fail: vec![],
        }
    }
    fn new(names: &[(u32, &str)]) -> Self {
        FakeTable {
            procs: names.iter().map(|(p, n)| Proc { pid: *p, name: n.to_string(), path: None }).collect(),
            killed: RefCell::new(vec![]),
            fail: vec![],
        }
    }
}
impl ProcessTable for FakeTable {
    fn list(&self) -> Vec<Proc> {
        self.procs.clone()
    }
    fn kill(&self, pid: u32) -> bool {
        self.killed.borrow_mut().push(pid);
        !self.fail.contains(&pid)
    }
}

fn s(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| x.to_string()).collect()
}
fn names(v: &[Proc]) -> Vec<&str> {
    v.iter().map(|p| p.name.as_str()).collect()
}
fn empty() -> Decision {
    Decision { block_sites: vec![], block_apps: vec![], block_folders: vec![], allow: None, frozen: false, locks: vec![] }
}
fn blocking(apps: &[&str]) -> Decision {
    Decision { block_apps: s(apps), ..empty() }
}
fn frozen(allow: &[&str]) -> Decision {
    Decision { frozen: true, allow: Some(Allow { sites: vec![], apps: s(allow) }), ..empty() }
}

#[test]
fn blocked_app_killed_neighbour_spared() {
    let t = FakeTable::new(&[(100, "game.exe"), (101, "code.exe")]);
    let r = enforce_once(&blocking(&["game.exe"]), &t, 1);
    assert_eq!(names(&r), ["game.exe"]);
    assert_eq!(*t.killed.borrow(), vec![100]);
}

#[test]
fn case_and_path_insensitive() {
    let t = FakeTable::new(&[(100, "GAME.EXE"), (101, "C:\\Games\\Game.exe"), (102, "game")]);
    let r = enforce_once(&blocking(&["Game.Exe"]), &t, 1);
    assert_eq!(r.len(), 3);
}

#[test]
fn frozen_empty_allow_spares_critical_and_self() {
    let mut list: Vec<(u32, &str)> = vec![(100, "notepad.exe"), (101, "chrome.exe"), (7, "myself.exe")];
    for (i, c) in CRITICAL_APPS.iter().enumerate() {
        list.push((1000 + i as u32, c));
    }
    let t = FakeTable::new(&list);
    let r = enforce_once(&frozen(&[]), &t, 7);
    assert_eq!(names(&r), ["notepad.exe", "chrome.exe"]);
    assert_eq!(*t.killed.borrow(), vec![100, 101]);
}

#[test]
fn frozen_allow_spares_listed() {
    let t = FakeTable::new(&[(100, "code.exe"), (101, "notepad.exe")]);
    let r = enforce_once(&frozen(&["code.exe"]), &t, 1);
    assert_eq!(names(&r), ["notepad.exe"]);
}

#[test]
fn allow_list_decision_kills_others_spares_critical() {
    let d = Decision { allow: Some(Allow { sites: vec![], apps: s(&["code.exe"]) }), ..empty() };
    let t = FakeTable::new(&[(100, "code.exe"), (101, "steam.exe"), (102, "explorer.exe"), (103, "svchost.exe")]);
    let r = enforce_once(&d, &t, 1);
    assert_eq!(names(&r), ["steam.exe"]);
}

#[test]
fn vpn_killed_only_while_a_window_is_active() {
    let list: Vec<(u32, &str)> = VPN_APPS.iter().enumerate().map(|(i, n)| (200 + i as u32, *n)).collect();
    for d in [
        blocking(&["game.exe"]),
        Decision { block_sites: s(&["x.com"]), ..empty() },
        frozen(&["code.exe"]),
        Decision { allow: Some(Allow { sites: vec![], apps: vec![] }), ..empty() },
    ] {
        let t = FakeTable::new(&list);
        assert_eq!(enforce_once(&d, &t, 1).len(), VPN_APPS.len());
    }
    let t = FakeTable::new(&list);
    assert!(enforce_once(&empty(), &t, 1).is_empty());
    assert!(t.killed.borrow().is_empty());
}

#[test]
fn empty_decision_kills_nothing() {
    let t = FakeTable::new(&[(100, "notepad.exe"), (101, "OpenVPN.exe")]);
    assert!(enforce_once(&empty(), &t, 1).is_empty());
    assert!(t.killed.borrow().is_empty());
}

#[test]
fn failed_kill_not_reported() {
    let mut t = FakeTable::new(&[(100, "game.exe"), (101, "game.exe")]);
    t.fail = vec![100];
    let r = enforce_once(&blocking(&["game.exe"]), &t, 1);
    assert_eq!(r.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![101]);
    assert_eq!(*t.killed.borrow(), vec![100, 101]);
}

#[test]
fn critical_in_other_case_or_path_spared() {
    let t = FakeTable::new(&[
        (100, "LSASS.EXE"),
        (101, "C:\\Windows\\System32\\svchost.exe"),
        (102, "Explorer"),
        (103, "MyBrain.exe"),
    ]);
    assert!(enforce_once(&frozen(&[]), &t, 1).is_empty());
    // Even if a window explicitly names a critical app, it is spared.
    assert!(enforce_once(&blocking(&["lsass.exe"]), &t, 1).is_empty());
    assert!(t.killed.borrow().is_empty());
}

#[test]
fn pid_0_4_and_self_never_killed() {
    let t = FakeTable::new(&[(0, "game.exe"), (4, "game.exe"), (9, "game.exe"), (10, "game.exe")]);
    let r = enforce_once(&blocking(&["game.exe"]), &t, 9);
    assert_eq!(r.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![10]);
}

#[test]
fn unnamed_and_placeholder_never_killed() {
    let t = FakeTable::new(&[(100, ""), (101, "   "), (102, "<no name> Process 5"), (103, "<unknown>")]);
    assert!(enforce_once(&frozen(&[]), &t, 1).is_empty());
    assert!(t.killed.borrow().is_empty());
}

fn folders(f: &[&str]) -> Decision {
    Decision { block_folders: s(f), ..empty() }
}

#[test]
fn kills_process_inside_blocked_folder() {
    let t = FakeTable::with_paths(&[
        (100, "game.exe", Some("C:\\Games\\Foo\\game.exe")),
        (101, "code.exe", Some("C:\\Tools\\code.exe")),
    ]);
    let r = enforce_once(&folders(&["C:\\Games"]), &t, 1);
    assert_eq!(names(&r), ["game.exe"]);
    assert_eq!(*t.killed.borrow(), vec![100]);
}

#[test]
fn spares_sibling_folder() {
    let t = FakeTable::with_paths(&[(100, "a.exe", Some("C:\\GamesX\\a.exe"))]);
    assert!(enforce_once(&folders(&["C:\\Games"]), &t, 1).is_empty());
    assert!(t.killed.borrow().is_empty());
}

#[test]
fn spares_process_with_unknown_path() {
    let t = FakeTable::with_paths(&[(100, "a.exe", None)]);
    assert!(enforce_once(&folders(&["C:\\Games"]), &t, 1).is_empty());
    assert!(t.killed.borrow().is_empty());
}

#[test]
fn critical_app_inside_blocked_folder_survives() {
    let t = FakeTable::with_paths(&[
        (100, "explorer.exe", Some("C:\\Games\\explorer.exe")),
        (4, "game.exe", Some("C:\\Games\\game.exe")),
        (7, "game.exe", Some("C:\\Games\\self.exe")),
    ]);
    let r = enforce_once(&folders(&["C:\\Games"]), &t, 7);
    assert!(r.is_empty());
    assert!(t.killed.borrow().is_empty());
}

#[test]
fn folder_rule_alone_counts_as_active_window() {
    assert!(focus_helper::enforce::any_window_active(&folders(&["C:\\Games"])));
    let t = FakeTable::with_paths(&[(100, "openvpn.exe", Some("C:\\x\\openvpn.exe"))]);
    assert_eq!(names(&enforce_once(&folders(&["C:\\Games"]), &t, 1)), ["openvpn.exe"]);
}
