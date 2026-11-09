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
    let w = json!({"id":"w-stdio","starts":now-3_600_000,"ends":now+3_600_000,"lock":"locked","mode":"block","sites":["x.com"],"apps":[]});

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
