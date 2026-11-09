//! Rendering of the managed block in the hosts file.

pub const BEGIN: &str = "# BEGIN MYBRAIN-FOCUS";
pub const END: &str = "# END MYBRAIN-FOCUS";

fn content(line: &str) -> &str {
    line.trim_end_matches(|c| c == '\n' || c == '\r')
}

/// Defence in depth: only plain host names are ever written.
fn site_ok(d: &str) -> bool {
    !d.is_empty()
        && !d
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '#' | '/' | '\\'))
}

/// Remove any managed block, then append a fresh one when `sites` is non-empty.
/// All other lines are kept byte-for-byte; the file's dominant line ending is used.
pub fn render(existing: &str, sites: &[String]) -> String {
    let crlf = existing.matches("\r\n").count();
    let lf = existing.matches('\n').count() - crlf;
    let eol = if crlf > lf { "\r\n" } else { "\n" };

    let lines: Vec<&str> = existing.split_inclusive('\n').collect();
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        if content(lines[i]).trim() != BEGIN {
            out.push_str(lines[i]);
            i += 1;
            continue;
        }
        // Skip the block: through END if present, otherwise only the managed lines.
        // The END search stops at the next BEGIN: a stray BEGIN must not swallow
        // user lines up to a later, complete block.
        let end = (i + 1..lines.len())
            .take_while(|&j| content(lines[j]).trim() != BEGIN)
            .find(|&j| content(lines[j]).trim() == END);
        i = match end {
            Some(j) => j + 1,
            None => {
                let mut j = i + 1;
                while j < lines.len()
                    && (content(lines[j]).starts_with("0.0.0.0 ") || content(lines[j]).starts_with(":: "))
                {
                    j += 1;
                }
                j
            }
        };
    }

    if sites.iter().any(|d| site_ok(d)) {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push_str(eol);
        }
        out.push_str(BEGIN);
        out.push_str(eol);
        for d in sites.iter().filter(|d| site_ok(d)) {
            for prefix in ["", "www.", "m."] {
                // IPv4 and IPv6 sinks, so AAAA lookups are blocked as well.
                out.push_str(&format!("0.0.0.0 {prefix}{d}{eol}"));
                out.push_str(&format!(":: {prefix}{d}{eol}"));
            }
        }
        out.push_str(END);
        out.push_str(eol);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn empty_input() {
        let out = render("", &s(&["a.com"]));
        assert_eq!(
            out,
            "# BEGIN MYBRAIN-FOCUS\n0.0.0.0 a.com\n:: a.com\n0.0.0.0 www.a.com\n:: www.a.com\n0.0.0.0 m.a.com\n:: m.a.com\n# END MYBRAIN-FOCUS\n"
        );
    }

    #[test]
    fn crlf_input() {
        let out = render("127.0.0.1 localhost\r\n::1 localhost\r\n", &s(&["a.com"]));
        assert!(out.starts_with("127.0.0.1 localhost\r\n::1 localhost\r\n# BEGIN MYBRAIN-FOCUS\r\n"));
        assert!(out.ends_with("# END MYBRAIN-FOCUS\r\n"));
        assert!(!out.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn no_trailing_newline() {
        let out = render("127.0.0.1 localhost", &s(&["a.com"]));
        assert!(out.starts_with("127.0.0.1 localhost\n# BEGIN MYBRAIN-FOCUS\n"));
    }

    #[test]
    fn preserves_user_entries_and_comments() {
        let base = "# my comment\n10.0.0.5 nas.local\n\n127.0.0.1 localhost\n";
        let out = render(base, &s(&["a.com", "b.org"]));
        assert!(out.starts_with(base));
        assert!(out.contains("0.0.0.0 m.b.org\n"));
        assert!(out.contains(":: m.b.org\n"));
        let with_after = format!("{out}192.168.0.1 router\n");
        let again = render(&with_after, &s(&["c.com"]));
        assert!(again.starts_with(base));
        assert!(again.contains("192.168.0.1 router\n"));
        assert!(!again.contains("a.com"));
    }

    #[test]
    fn idempotent() {
        for base in ["", "127.0.0.1 localhost\n", "127.0.0.1 localhost", "a\r\nb\r\n"] {
            let once = render(base, &s(&["a.com"]));
            assert_eq!(render(&once, &s(&["a.com"])), once);
        }
    }

    #[test]
    fn empty_sites_removes_block() {
        let base = "127.0.0.1 localhost\n";
        let with = render(base, &s(&["a.com"]));
        assert_eq!(render(&with, &[]), base);
    }

    #[test]
    fn missing_end_marker_does_not_eat_file() {
        let broken = "x\n# BEGIN MYBRAIN-FOCUS\n0.0.0.0 a.com\n:: a.com\n0.0.0.0 www.a.com\n:: www.a.com\nkeep me\n";
        assert_eq!(render(broken, &[]), "x\nkeep me\n");
    }

    #[test]
    fn stray_begin_does_not_eat_lines_before_later_block() {
        let f = "# BEGIN MYBRAIN-FOCUS\n0.0.0.0 old.com\nuser line\n# BEGIN MYBRAIN-FOCUS\n0.0.0.0 a.com\n# END MYBRAIN-FOCUS\ntail\n";
        assert_eq!(render(f, &[]), "user line\ntail\n");
    }

    #[test]
    fn crlf_block_removal_and_empty_sites() {
        let base = "127.0.0.1 localhost\r\n";
        let with = render(base, &s(&["a.com"]));
        assert_eq!(render(&with, &[]), base);
        assert_eq!(render(base, &[]), base);
    }

    #[test]
    fn unsafe_sites_are_skipped() {
        let bad = s(&["", "a b.com", "a\tb", "x#y", "x/y", "x\\y", "a\u{7}b", "ok.com"]);
        let out = render("", &bad);
        assert_eq!(out.matches("0.0.0.0 ok.com\n").count(), 1);
        assert_eq!(out.matches("0.0.0.0 ").count(), 3);
        assert_eq!(out.matches(":: ").count(), 3);
        assert_eq!(out.matches(":: ok.com\n").count(), 1);
        assert_eq!(render("x\n", &s(&["a b"])), "x\n");
    }
}
