use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

fn partner_key() -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/unlock-vectors.json");
    let v: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    v.into_iter().find(|x| x["name"] == "valid").unwrap()["publicKey"].as_str().unwrap().to_string()
}

#[test]
fn stdio_round_trip_keeps_locked_window() {
    let dir = std::env::temp_dir().join(format!("focus-stdio-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let state = dir.join("state.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_focus-helper"))
        .args(["stdio", "--state"])
        .arg(&state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut call = |line: String| -> Value {
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
        let mut reply = String::new();
        out.read_line(&mut reply).unwrap();
        serde_json::from_str(&reply).unwrap()
    };

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
    let w = json!({"id":"w-stdio","starts":now-3_600_000,"ends":now+3_600_000,"lock":"locked","mode":"block","sites":["x.com"],"apps":[],"unlock_delay_ms":86400000});

    assert_eq!(call(json!({"type":"SetPartner","public_key":partner_key()}).to_string())["type"], "Ok");
    assert_eq!(call(json!({"type":"PushWindows","windows":[w]}).to_string())["type"], "Ok");
    let st = call(r#"{"type":"GetStatus"}"#.into());
    assert_eq!(st["partner_set"], true);
    assert_eq!(st["windows"][0]["id"], "w-stdio");
    assert_eq!(st["warnings"], json!([]));

    assert_eq!(call(json!({"type":"PushWindows","windows":[]}).to_string())["type"], "Ok");
    let st = call(r#"{"type":"GetStatus"}"#.into());
    assert_eq!(st["windows"].as_array().unwrap().len(), 1);
    assert_eq!(st["windows"][0]["id"], "w-stdio");

    let bad = call("not json".into());
    assert_eq!(bad["type"], "Error");
    assert_eq!(bad["code"], "bad-request");
    assert_eq!(call(r#"{"type":"GetStatus"}"#.into())["type"], "Status");

    drop(stdin);
    assert_eq!(child.wait().unwrap().code(), Some(0));
    assert!(state.exists());
}

#[test]
fn unknown_args_exit_2() {
    let st = Command::new(env!("CARGO_BIN_EXE_focus-helper")).arg("bogus").stderr(Stdio::null()).status().unwrap();
    assert_eq!(st.code(), Some(2));
}

#[cfg(not(windows))]
#[test]
fn send_is_windows_only_elsewhere() {
    let out = Command::new(env!("CARGO_BIN_EXE_focus-helper")).args(["send", r#"{"type":"GetStatus"}"#]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("Windows only"));
}

fn spawn_stdio(tag: &str) -> (std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>) {
    let dir = std::env::temp_dir().join(format!("focus-stdio-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_focus-helper"))
        .args(["stdio", "--state"])
        .arg(dir.join("state.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let out = BufReader::new(child.stdout.take().unwrap());
    (child, stdin, out)
}

fn roundtrip(stdin: &mut std::process::ChildStdin, out: &mut BufReader<std::process::ChildStdout>, line: &str) -> Value {
    writeln!(stdin, "{line}").unwrap();
    stdin.flush().unwrap();
    let mut reply = String::new();
    out.read_line(&mut reply).unwrap();
    serde_json::from_str(&reply).unwrap()
}

#[cfg(feature = "test-clock")]
#[test]
fn advance_clock_moves_effective_time() {
    let (mut child, mut stdin, mut out) = spawn_stdio("clock");
    let before = roundtrip(&mut stdin, &mut out, r#"{"type":"GetStatus"}"#)["now_ms"].as_i64().unwrap();
    assert_eq!(roundtrip(&mut stdin, &mut out, r#"{"type":"AdvanceClock","ms":3600000}"#)["type"], "Ok");
    assert_eq!(roundtrip(&mut stdin, &mut out, r#"{"type":"AdvanceClock","ms":1000}"#)["type"], "Ok");
    let after = roundtrip(&mut stdin, &mut out, r#"{"type":"GetStatus"}"#)["now_ms"].as_i64().unwrap();
    assert!(after - before >= 3_601_000, "before={before} after={after}");
    for bad in [r#"{"type":"AdvanceClock","ms":-1}"#, r#"{"type":"AdvanceClock","ms":1.5}"#, r#"{"type":"AdvanceClock"}"#, r#"{"type":"AdvanceClock","ms":"5"}"#] {
        let r = roundtrip(&mut stdin, &mut out, bad);
        assert_eq!(r["type"], "Error", "{bad}");
        assert_eq!(r["code"], "bad-request", "{bad}");
    }
    drop(stdin);
    assert_eq!(child.wait().unwrap().code(), Some(0));
}

#[cfg(not(feature = "test-clock"))]
#[test]
fn advance_clock_is_rejected_without_feature() {
    let (mut child, mut stdin, mut out) = spawn_stdio("noclock");
    let r = roundtrip(&mut stdin, &mut out, r#"{"type":"AdvanceClock","ms":1000}"#);
    assert_eq!(r["type"], "Error");
    assert_eq!(r["code"], "bad-request");
    drop(stdin);
    assert_eq!(child.wait().unwrap().code(), Some(0));
}

#[cfg(feature = "test-clock")]
#[test]
fn add_usage_then_get_usage_persists_across_restart() {
    let dir = std::env::temp_dir().join(format!("focus-stdio-usage-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let state = dir.join("state.json");
    let run = |lines: &[String]| -> Vec<Value> {
        let mut child = Command::new(env!("CARGO_BIN_EXE_focus-helper"))
            .args(["stdio", "--state"])
            .arg(&state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut replies = Vec::new();
        for l in lines {
            writeln!(stdin, "{l}").unwrap();
            stdin.flush().unwrap();
            let mut r = String::new();
            out.read_line(&mut r).unwrap();
            replies.push(serde_json::from_str(&r).unwrap());
        }
        drop(stdin);
        assert_eq!(child.wait().unwrap().code(), Some(0));
        replies
    };
    let get = r#"{"type":"GetUsage","from_day":"2026-11-01","to_day":"2026-11-30"}"#.to_string();
    let add = json!({"type":"AddUsage","day":{"day":"2026-11-10","total":90,"apps":{"chrome.exe":90},"sites":{},"other_browsing":90}}).to_string();
    let r = run(&[add, get.clone()]);
    assert_eq!(r[0]["type"], "Ok");
    assert_eq!(r[1]["type"], "Usage");
    assert_eq!(r[1]["days"][0]["total"], 90);
    assert!(dir.join("usage.json").exists());
    let r = run(&[get]);
    assert_eq!(r[0]["days"][0]["apps"]["chrome.exe"], 90);
    let st = run(&[r#"{"type":"GetStatus"}"#.to_string()]);
    assert_eq!(st[0]["usage_tracking"], false);
}

#[cfg(feature = "test-clock")]
#[test]
fn uninstall_wait_becomes_permit_after_advance_clock() {
    let (mut child, mut stdin, mut out) = spawn_stdio("uninstall");
    let r = roundtrip(&mut stdin, &mut out, r#"{"type":"RequestUninstallDelay"}"#);
    assert_eq!(r["type"], "UninstallPending");
    let unlock_at = r["unlock_at"].as_i64().unwrap();
    let st = roundtrip(&mut stdin, &mut out, r#"{"type":"GetStatus"}"#);
    assert_eq!(st["uninstall"]["pending_at"], unlock_at);
    assert_eq!(st["uninstall"]["wait_ms"], 86_400_000);
    assert_eq!(roundtrip(&mut stdin, &mut out, r#"{"type":"AdvanceClock","ms":86400100}"#)["type"], "Ok");
    let st = roundtrip(&mut stdin, &mut out, r#"{"type":"GetStatus"}"#);
    assert_eq!(st["uninstall"]["pending_at"], Value::Null);
    assert_eq!(st["uninstall"]["permit_until"], unlock_at + 3_600_000);
    assert_eq!(roundtrip(&mut stdin, &mut out, r#"{"type":"AdvanceClock","ms":3600000}"#)["type"], "Ok");
    let st = roundtrip(&mut stdin, &mut out, r#"{"type":"GetStatus"}"#);
    assert_eq!(st["uninstall"]["permit_until"], Value::Null);
    assert_eq!(roundtrip(&mut stdin, &mut out, r#"{"type":"CancelUninstallDelay"}"#)["code"], "no-pending-uninstall");
    drop(stdin);
    assert_eq!(child.wait().unwrap().code(), Some(0));
}
