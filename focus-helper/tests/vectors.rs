use focus_helper::decide::{decide, is_blocked_app, is_blocked_site};
use focus_helper::model::{Decision, Window};
use serde_json::Value;

#[test]
fn shared_vectors() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/decide-vectors.json");
    let raw = std::fs::read_to_string(path).expect("read vectors");
    let vectors: Vec<Value> = serde_json::from_str(&raw).expect("parse vectors");
    assert!(!vectors.is_empty());
    for v in &vectors {
        let name = v["name"].as_str().unwrap();
        let windows: Vec<Window> = serde_json::from_value(v["windows"].clone()).unwrap();
        let now = v["now"].as_i64().unwrap();
        let d: Decision = decide(&windows, now);
        assert_eq!(serde_json::to_value(&d).unwrap(), v["decision"], "decision: {name}");
        for p in v["probes"].as_array().unwrap() {
            let value = p["value"].as_str().unwrap();
            let got = match p["kind"].as_str().unwrap() {
                "site" => is_blocked_site(&d, value),
                "app" => is_blocked_app(&d, value),
                k => panic!("unknown kind {k}"),
            };
            assert_eq!(got, p["blocked"].as_bool().unwrap(), "{name}: {value}");
        }
    }
}
