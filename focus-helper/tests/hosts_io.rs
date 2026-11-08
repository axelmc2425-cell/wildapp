use focus_helper::hosts_io::apply;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("focus-hosts-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d.join("hosts")
}
fn s(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| x.to_string()).collect()
}
fn tmpfile(p: &PathBuf) -> PathBuf {
    let mut o = p.clone().into_os_string();
    o.push(".focus-tmp");
    PathBuf::from(o)
}

#[test]
fn creates_missing_file() {
    let p = tmp("create");
    assert!(apply(&p, &s(&["a.com"])).unwrap());
    let t = fs::read_to_string(&p).unwrap();
    assert!(t.contains("0.0.0.0 www.a.com\n"));
    assert!(!tmpfile(&p).exists());
}

#[test]
fn keeps_user_entries_crlf_and_comments() {
    let p = tmp("keep");
    fs::write(&p, "# note\r\n127.0.0.1 localhost\r\n").unwrap();
    assert!(apply(&p, &s(&["a.com"])).unwrap());
    let t = fs::read_to_string(&p).unwrap();
    assert!(t.starts_with("# note\r\n127.0.0.1 localhost\r\n# BEGIN MYBRAIN-FOCUS\r\n"));
    assert!(!t.replace("\r\n", "").contains('\n'));
}

#[test]
fn second_apply_is_noop() {
    let p = tmp("noop");
    assert!(apply(&p, &s(&["a.com"])).unwrap());
    let before = fs::read(&p).unwrap();
    let m1 = fs::metadata(&p).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert!(!apply(&p, &s(&["a.com"])).unwrap());
    assert_eq!(fs::read(&p).unwrap(), before);
    assert_eq!(fs::metadata(&p).unwrap().modified().unwrap(), m1);
    assert!(!tmpfile(&p).exists());
}

#[test]
fn empty_sites_removes_only_block() {
    let p = tmp("empty");
    fs::write(&p, "127.0.0.1 localhost\n").unwrap();
    apply(&p, &s(&["a.com"])).unwrap();
    assert!(apply(&p, &[]).unwrap());
    assert_eq!(fs::read_to_string(&p).unwrap(), "127.0.0.1 localhost\n");
}

#[test]
fn leftover_tmp_is_overwritten_not_read() {
    let p = tmp("leftover");
    fs::write(&p, "127.0.0.1 localhost\n").unwrap();
    fs::write(tmpfile(&p), "evil.example 1.2.3.4\n").unwrap();
    assert!(apply(&p, &s(&["a.com"])).unwrap());
    let t = fs::read_to_string(&p).unwrap();
    assert!(!t.contains("evil.example"));
    assert!(t.starts_with("127.0.0.1 localhost\n"));
    assert!(!tmpfile(&p).exists());
}

#[test]
fn non_utf8_is_invalid_data_and_untouched() {
    let p = tmp("utf8");
    let bytes = vec![0x31, 0x32, 0xff, 0xfe, b'\n'];
    fs::write(&p, &bytes).unwrap();
    let e = apply(&p, &s(&["a.com"])).unwrap_err();
    assert_eq!(e.kind(), ErrorKind::InvalidData);
    assert_eq!(fs::read(&p).unwrap(), bytes);
    assert!(!tmpfile(&p).exists());
}
