//! Portable website matcher: attributes a browser window title to a site.
//! Titles are only inspected in memory; nothing here stores or logs them.

const BROWSERS: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
];

/// Pairs of (label as it appears in window titles, canonical name).
/// Labels are matched case-insensitively and as whole words.
pub const SITE_MAP: &[(&str, &str)] = &[
    ("YouTube", "YouTube"),
    ("Reddit", "Reddit"),
    ("Twitter", "Twitter"),
    // A bare "X" would match far too much; X titles end in "/ X".
    ("/ X", "X"),
    ("Facebook", "Facebook"),
    ("Instagram", "Instagram"),
    ("TikTok", "TikTok"),
    ("Netflix", "Netflix"),
    ("Twitch", "Twitch"),
    ("GitHub", "GitHub"),
    ("GitLab", "GitLab"),
    ("Bitbucket", "Bitbucket"),
    ("Wikipedia", "Wikipedia"),
    ("Amazon", "Amazon"),
    ("Gmail", "Gmail"),
    ("LinkedIn", "LinkedIn"),
    ("Discord", "Discord"),
    ("WhatsApp", "WhatsApp"),
    ("Spotify", "Spotify"),
    ("ChatGPT", "ChatGPT"),
    ("Claude", "Claude"),
    ("Gemini", "Gemini"),
    ("Perplexity", "Perplexity"),
    ("Copilot", "Copilot"),
    ("Google Docs", "Google Docs"),
    ("Google Sheets", "Google Sheets"),
    ("Google Slides", "Google Slides"),
    ("Google Drive", "Google Drive"),
    ("Google Calendar", "Google Calendar"),
    ("Google Maps", "Google Maps"),
    ("Google Meet", "Google Meet"),
    ("Google Photos", "Google Photos"),
    ("Google Translate", "Google Translate"),
    ("Google Scholar", "Google Scholar"),
    ("Google News", "Google News"),
    ("Outlook", "Outlook"),
    ("Microsoft Teams", "Microsoft Teams"),
    ("OneDrive", "OneDrive"),
    ("SharePoint", "SharePoint"),
    ("Bing", "Bing"),
    ("DuckDuckGo", "DuckDuckGo"),
    ("Yahoo", "Yahoo"),
    ("Pinterest", "Pinterest"),
    ("Tumblr", "Tumblr"),
    ("Snapchat", "Snapchat"),
    ("Telegram", "Telegram"),
    ("Messenger", "Messenger"),
    ("Slack", "Slack"),
    ("Zoom", "Zoom"),
    ("Skype", "Skype"),
    ("Notion", "Notion"),
    ("Trello", "Trello"),
    ("Asana", "Asana"),
    ("Jira", "Jira"),
    ("Confluence", "Confluence"),
    ("Figma", "Figma"),
    ("Canva", "Canva"),
    ("Dropbox", "Dropbox"),
    ("Evernote", "Evernote"),
    ("Stack Overflow", "Stack Overflow"),
    ("Hacker News", "Hacker News"),
    ("Quora", "Quora"),
    ("Substack", "Substack"),
    ("WordPress", "WordPress"),
    ("Wix", "Wix"),
    ("Shopify", "Shopify"),
    ("eBay", "eBay"),
    ("Etsy", "Etsy"),
    ("AliExpress", "AliExpress"),
    ("Walmart", "Walmart"),
    ("PayPal", "PayPal"),
    ("Stripe", "Stripe"),
    ("Booking.com", "Booking.com"),
    ("Airbnb", "Airbnb"),
    ("TripAdvisor", "TripAdvisor"),
    ("Uber", "Uber"),
    ("Yelp", "Yelp"),
    ("IMDb", "IMDb"),
    ("Hulu", "Hulu"),
    ("Disney+", "Disney+"),
    ("Prime Video", "Prime Video"),
    ("HBO Max", "HBO Max"),
    ("Crunchyroll", "Crunchyroll"),
    ("Vimeo", "Vimeo"),
    ("SoundCloud", "SoundCloud"),
    ("Pandora", "Pandora"),
    ("Steam", "Steam"),
    ("Epic Games", "Epic Games"),
    ("Roblox", "Roblox"),
    ("Coursera", "Coursera"),
    ("Udemy", "Udemy"),
    ("Khan Academy", "Khan Academy"),
    ("Duolingo", "Duolingo"),
    ("Quizlet", "Quizlet"),
    ("BBC", "BBC"),
    ("CNN", "CNN"),
    ("The Guardian", "The Guardian"),
    ("New York Times", "New York Times"),
    ("Washington Post", "Washington Post"),
    ("Fox News", "Fox News"),
    ("Reuters", "Reuters"),
    ("Bloomberg", "Bloomberg"),
    ("Forbes", "Forbes"),
    ("TechCrunch", "TechCrunch"),
    ("The Verge", "The Verge"),
    ("Product Hunt", "Product Hunt"),
    ("Vercel", "Vercel"),
    ("Supabase", "Supabase"),
    ("npm", "npm"),
    ("Docker Hub", "Docker Hub"),
    ("MDN Web Docs", "MDN Web Docs"),
    ("CodePen", "CodePen"),
    ("LeetCode", "LeetCode"),
];

/// True when `exe` (a base name such as `chrome.exe`) is a known browser.
pub fn is_browser(exe: &str) -> bool {
    BROWSERS.iter().any(|b| b.eq_ignore_ascii_case(exe))
}

/// Second-level labels that sit under a two-letter country TLD (`co.uk`).
const SLD: &[&str] = &["co", "com", "org", "net", "gov", "edu", "ac", "ne", "or", "go"];

/// Stems shorter than this are ignored.
const MIN_STEM_LEN: usize = 3;

/// The site stem of each domain (`reddit.com` -> `reddit`), lowercase, deduped, in order;
/// stems under 3 characters are dropped.
pub fn stems_from_domains(domains: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for d in domains {
        let d = d.trim().trim_matches('.').to_lowercase();
        let labels: Vec<&str> = d.split('.').filter(|l| !l.is_empty()).collect();
        let stem = match labels.len() {
            0 => continue,
            1 => labels[0],
            n => {
                let last = labels[n - 1];
                let second = labels[n - 2];
                if n >= 3 && last.len() == 2 && SLD.contains(&second) {
                    labels[n - 3]
                } else {
                    second
                }
            }
        };
        // Very short stems (`x.com` -> `x`) would false-match ordinary titles.
        if stem.chars().count() < MIN_STEM_LEN {
            continue;
        }
        if !out.iter().any(|s| s == stem) {
            out.push(stem.to_string());
        }
    }
    out
}

/// Earliest whole-word, case-insensitive occurrence of `needle` in `hay`
/// (both already ASCII-lowercased; positions are byte offsets in the original).
fn find_whole_word(hay: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let mut from = 0;
    while let Some(rel) = hay[from..].find(needle) {
        let pos = from + rel;
        let end = pos + needle.len();
        let before_ok = hay[..pos].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
        let after_ok = hay[end..].chars().next().is_none_or(|c| !c.is_alphanumeric());
        if before_ok && after_ok {
            return Some(pos);
        }
        // Advance one character (needle starts at an ASCII byte or char boundary).
        from = pos + hay[pos..].chars().next().map_or(1, |c| c.len_utf8());
    }
    None
}

/// The site label for a browser window title, or None. The earliest match in the
/// title wins; on a tie the built-in map beats the owner's stems.
pub fn match_site(title: &str, extra_stems: &[String]) -> Option<String> {
    let hay = title.to_ascii_lowercase();
    let mut best: Option<(usize, String)> = None;
    let mut consider = |pos: usize, name: &str| {
        if best.as_ref().is_none_or(|(p, _)| pos < *p) {
            best = Some((pos, name.to_string()));
        }
    };
    for (label, name) in SITE_MAP {
        if let Some(p) = find_whole_word(&hay, &label.to_ascii_lowercase()) {
            consider(p, name);
        }
    }
    for stem in extra_stems {
        if let Some(p) = find_whole_word(&hay, &stem.to_ascii_lowercase()) {
            consider(p, stem);
        }
    }
    best.map(|(_, n)| n)
}
