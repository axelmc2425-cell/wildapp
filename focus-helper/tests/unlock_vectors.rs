use focus_helper::unlock::{verify, Challenge};
use serde_json::Value;

#[test]
fn shared_unlock_vectors() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/unlock-vectors.json");
    let raw = std::fs::read_to_string(path).expect("read vectors");
    let vectors: Vec<Value> = serde_json::from_str(&raw).expect("parse vectors");
    assert!(vectors.len() >= 9);
    for v in &vectors {
        let name = v["name"].as_str().unwrap();
        let challenge: Challenge = serde_json::from_value(v["challenge"].clone()).unwrap();
        let got = verify(
            v["publicKey"].as_str().unwrap(),
            v["token"].as_str().unwrap(),
            &challenge,
            v["now"].as_i64().unwrap(),
        );
        let expect = &v["expect"];
        if expect["ok"].as_bool().unwrap() {
            assert_eq!(got, Ok(()), "{name}");
        } else {
            let reason = expect["reason"].as_str().unwrap();
            assert_eq!(got.err().map(|e| e.reason()), Some(reason), "{name}");
        }
    }
}
