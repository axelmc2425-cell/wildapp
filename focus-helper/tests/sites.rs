use focus_helper::sites::{is_browser, match_site, stems_from_domains, SITE_MAP};

#[test]
fn browser_detection() {
    for e in ["Chrome.EXE", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"] {
        assert!(is_browser(e), "{e}");
    }
    for e in ["notepad.exe", "chromedriver.exe", ""] {
        assert!(!is_browser(e), "{e}");
    }
}

#[test]
fn known_titles() {
    assert_eq!(match_site("Funny cats - YouTube - Google Chrome", &[]), Some("YouTube".into()));
    assert_eq!(match_site("(3) Facebook", &[]), Some("Facebook".into()));
    assert_eq!(match_site("r/rust - Reddit", &[]), Some("Reddit".into()));
}

#[test]
fn whole_word_only() {
    let s = vec!["reddit".to_string()];
    assert_eq!(match_site("Predicted outcomes", &s), None);
    assert_eq!(match_site("Redditors unite", &s), None);
    assert_eq!(match_site("Home / Reddit", &s), Some("Reddit".into()));
}

#[test]
fn own_stems_match_when_not_in_map() {
    assert_eq!(match_site("Inbox | acmecorp", &["acmecorp".to_string()]), Some("acmecorp".into()));
}

#[test]
fn first_match_wins() {
    assert_eq!(match_site("Netflix and YouTube", &[]), Some("Netflix".into()));
    assert_eq!(match_site("YouTube vs Netflix", &[]), Some("YouTube".into()));
    assert_eq!(match_site("acmecorp then YouTube", &["acmecorp".to_string()]), Some("acmecorp".into()));
}

#[test]
fn none_is_none() {
    assert_eq!(match_site("Untitled", &[]), None);
}

#[test]
fn stems() {
    let d = vec!["reddit.com".to_string(), "www.news.bbc.co.uk".to_string(), "reddit.com".to_string()];
    assert_eq!(stems_from_domains(&d), vec!["reddit".to_string(), "bbc".to_string()]);
}

#[test]
fn map_is_sane() {
    assert!(SITE_MAP.len() >= 90);
    let mut seen = std::collections::HashSet::new();
    for (label, name) in SITE_MAP {
        assert!(!label.is_empty() && label.is_ascii(), "{label}");
        assert!(!name.is_empty() && name.is_ascii(), "{name}");
        assert!(seen.insert((label.to_ascii_lowercase(), *name)), "dup {label}/{name}");
    }
}

fn stems_of(ds: &[&str]) -> Vec<String> {
    stems_from_domains(&ds.iter().map(|s| s.to_string()).collect::<Vec<_>>())
}

#[test]
fn short_stems_are_dropped() {
    assert!(stems_of(&["x.com"]).is_empty());
    assert!(stems_of(&["ox.ac.uk"]).is_empty());
    assert_eq!(stems_of(&["x.com", "abc.com"]), vec!["abc".to_string()]);
    // The dropped stem must not false-match titles.
    assert_eq!(match_site("Chapter X", &stems_of(&["x.com"])), None);
}

#[test]
fn stem_edge_inputs() {
    assert!(stems_of(&[""]).is_empty());
    assert!(stems_of(&["."]).is_empty());
    assert_eq!(stems_of(&["reddit"]), vec!["reddit".to_string()]);
    assert_eq!(stems_of(&["reddit.com."]), vec!["reddit".to_string()]);
    assert_eq!(stems_of(&["Reddit.COM", "reddit.com"]), vec!["reddit".to_string()]);
    assert_eq!(stems_of(&["example.com.au"]), vec!["example".to_string()]);
    assert_eq!(stems_of(&["www.cam.ac.uk"]), vec!["cam".to_string()]);
}
