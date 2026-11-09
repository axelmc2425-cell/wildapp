use focus_helper::lockstore::good_item;
use serde_json::Value;

#[test]
fn shared_item_vectors() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/item-vectors.json");
    let vectors: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(vectors.len() > 30);
    for v in &vectors {
        let value = v["value"].as_str().unwrap();
        let is_site = match v["kind"].as_str().unwrap() {
            "site" => true,
            "app" => false,
            k => panic!("unknown kind {k}"),
        };
        assert_eq!(good_item(value, is_site), v["valid"].as_bool().unwrap(), "{v}");
    }
}
