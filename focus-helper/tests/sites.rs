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
